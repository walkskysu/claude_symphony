// Agent Runner (SPEC §10.7, §16.5): workspace + prompt + Claude session + continuation turns.
import fs from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../config.ts";
import { SymphonyError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { continuationPrompt, renderPrompt } from "../template.ts";
import type { AgentEvent, Issue, TrackerAdapter } from "../types.ts";
import { normState } from "../util.ts";
import { assertInsideRoot, type WorkspaceManager } from "../workspace.ts";
import { ClaudeSession } from "./claude.ts";
import type { ToolBridge } from "./tool-bridge.ts";

/** Env names never inherited by the agent child (in addition to adapter-declared secrets). */
const ALWAYS_SCRUB = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

export interface AttemptContext {
  issue: Issue;
  attempt: number | null;
  cfg: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  activeStates: string[];
  isRoutable: (issue: Issue) => boolean;
  workspaces: WorkspaceManager;
  bridge: ToolBridge | null;
  log: Logger;
  signal: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
  onWorkspace: (p: string) => void;
  onIssueRefresh: (issue: Issue) => void;
  onLogFile: (p: string) => void;
}

export type AttemptOutcome = { kind: "normal"; turns: number };

export function buildChildEnv(base: NodeJS.ProcessEnv, secretNames: string[], extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const n of [...secretNames, ...ALWAYS_SCRUB]) delete env[n];
  return { ...env, ...extra };
}

function issueEnv(issue: Issue, ws: string, tracker?: TrackerAdapter): Record<string, string> {
  return {
    ...(tracker?.issueEnvironment?.(issue) ?? {}),
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_URL: issue.url ?? "",
    SYMPHONY_WORKSPACE: ws,
  };
}

export async function runAgentAttempt(ctx: AttemptContext): Promise<AttemptOutcome> {
  const { cfg, workspaces, signal } = ctx;
  let issue = ctx.issue;
  const log = ctx.log;

  // 1. Workspace
  const ws = await workspaces.createForIssue(issue.identifier, issueEnv(issue, workspaces.pathFor(issue.identifier), ctx.tracker));
  ctx.onWorkspace(ws.path);
  if (signal.aborted) throw new SymphonyError("canceled_by_reconciliation", "canceled before start");

  const hookEnv = issueEnv(issue, ws.path, ctx.tracker);
  let session: ClaudeSession | null = null;
  let bridgeToken: string | null = null;
  try {
    await workspaces.runHook("before_run", ws.path, issue.identifier, hookEnv, true);

    // Safety invariants (SPEC §9.5) right before launch.
    assertInsideRoot(workspaces.root(), ws.path);
    const cwd = path.resolve(ws.path);
    if (cwd !== workspaces.pathFor(issue.identifier)) {
      throw new SymphonyError("invalid_workspace_cwd", `cwd ${cwd} != workspace path`);
    }

    // 2. Prompt (first turn)
    const firstPrompt = renderPrompt(ctx.promptTemplate, { issue, attempt: ctx.attempt });

    // 3. Tool bridge session bound to this adapter snapshot.
    let mcpJson: string | null = null;
    if (ctx.bridge && ctx.tracker.agentToolSpecs && ctx.tracker.executeAgentTool) {
      const specs = ctx.tracker.agentToolSpecs();
      if (specs.length) {
        const bs = ctx.bridge.register({
          adapter: ctx.tracker,
          specs,
          workspacePath: cwd,
          getIssue: () => issue,
          onToolEvent: (t) =>
            ctx.onEvent({
              event: t.supported ? (t.ok ? "tool_call_completed" : "tool_call_failed") : "unsupported_tool_call",
              timestamp: new Date().toISOString(),
              codex_app_server_pid: session?.pid ?? null,
              message: t.error ? `${t.name}: ${t.error}` : t.name,
            }),
        });
        bridgeToken = bs.token;
        mcpJson = ctx.bridge.mcpConfigJson(bs);
      }
    }

    // 4. Launch
    const secretNames = ctx.tracker.secretEnvironmentNames?.() ?? [];
    const logFile = path.join(
      cfg.logging.agent_log_dir,
      ws.workspace_key,
      `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    );
    ctx.onLogFile(logFile);
    session = new ClaudeSession({
      cfg: cfg.claude,
      cwd,
      env: buildChildEnv(process.env, secretNames, issueEnv(issue, cwd, ctx.tracker)),
      title: `${issue.identifier}: ${issue.title}`,
      mcpConfigJson: mcpJson,
      logFile,
      log,
      onEvent: ctx.onEvent,
      signal,
    });
    try {
      await session.start();
    } catch (err) {
      ctx.onEvent({
        event: "startup_failed",
        timestamp: new Date().toISOString(),
        codex_app_server_pid: session.pid,
        message: String((err as Error).message),
      });
      throw err;
    }
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const latest = path.join(path.dirname(logFile), "latest.log");
      fs.rmSync(latest, { force: true });
      fs.symlinkSync(path.basename(logFile), latest);
    } catch {
      /* best effort */
    }

    // 5. Turn loop
    const maxTurns = cfg.agent.max_turns;
    let turn = 1;
    while (true) {
      const prompt = turn === 1 ? firstPrompt : continuationPrompt(issue, turn, maxTurns);
      const res = await session.runTurn(prompt);
      log.info("agent turn completed", { session_id: res.session_id, turn, num_turns: res.num_turns });

      if (signal.aborted) throw new SymphonyError("canceled_by_reconciliation", "canceled");
      let refreshed: Issue[];
      try {
        refreshed = await ctx.tracker.fetchIssuesByIds([issue.id]);
      } catch (err) {
        throw new SymphonyError("tracker_request", `issue state refresh error: ${(err as Error).message}`);
      }
      if (refreshed.length === 0) {
        log.info("issue no longer visible; ending worker", {});
        break;
      }
      issue = refreshed[0];
      ctx.onIssueRefresh(issue);
      const active = ctx.activeStates.some((s) => normState(s) === normState(issue.state));
      if (!active || !ctx.isRoutable(issue)) {
        log.info("issue left active/routable set; ending worker", { state: issue.state });
        break;
      }
      if (turn >= maxTurns) {
        log.info("max turns reached; ending worker", { max_turns: maxTurns });
        break;
      }
      turn++;
    }
    return { kind: "normal", turns: turn };
  } finally {
    if (bridgeToken) ctx.bridge?.unregister(bridgeToken);
    if (session) await session.stop().catch(() => undefined);
    await workspaces.runHook("after_run", ws.path, issue.identifier, hookEnv, false).catch(() => undefined);
  }
}
