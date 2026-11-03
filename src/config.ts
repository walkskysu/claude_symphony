// Typed Config Layer (SPEC §6). Applies defaults, `$VAR` indirection for path/secret values, and
// validation. Unknown keys are ignored (forward compatibility).
import os from "node:os";
import path from "node:path";
import { SymphonyError } from "./errors.ts";
import type { WorkflowDefinition } from "./types.ts";
import { isPlainObject, normState, resolvePathValue } from "./util.ts";

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface ClaudeConfig {
  /** Shell command launched via `bash -lc` in the workspace. Symphony appends protocol flags. */
  command: string;
  model: string | null;
  permission_mode: string;
  permission_prompts: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  append_system_prompt: string | null;
  max_budget_usd: number | null;
  strict_mcp_config: boolean;
  extra_args: string[];
  /** Extra environment for the agent child (values support `$VAR`). */
  env: Record<string, string>;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface TrackerConfig {
  kind: string | null;
  provider: Record<string, unknown>;
  required_labels: string[];
  /** null => adapter default */
  active_states: string[] | null;
  terminal_states: string[] | null;
}

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: { interval_ms: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  claude: ClaudeConfig;
  server: { port: number | null; host: string };
  logging: { file: string | null; level: string | null; agent_log_dir: string };
}

function int(v: unknown, field: string, def: number, opts: { min?: number } = {}): number {
  if (v === undefined || v === null) return def;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new SymphonyError("invalid_config", `${field} must be an integer`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new SymphonyError("invalid_config", `${field} must be >= ${opts.min}`);
  }
  return n;
}

function str(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new SymphonyError("invalid_config", `${field} must be a string`);
  return v;
}

function strList(v: unknown, field: string): string[] | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new SymphonyError("invalid_config", `${field} must be a list of strings`);
  }
  return v as string[];
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new SymphonyError("invalid_config", `${field} must be a map`);
  return v;
}

function bool(v: unknown, field: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw new SymphonyError("invalid_config", `${field} must be a boolean`);
  return v;
}

/** Build the typed config view (SPEC §6.1 steps 3–5). Throws SymphonyError on invalid values. */
export function buildConfig(
  wf: WorkflowDefinition,
  workflowPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const c = wf.config;
  const workflowDir = path.dirname(path.resolve(workflowPath));

  // tracker
  const t = obj(c.tracker, "tracker");
  const tracker: TrackerConfig = {
    kind: str(t.kind, "tracker.kind")?.trim() || null,
    provider: obj(t.provider, "tracker.provider"),
    required_labels: strList(t.required_labels, "tracker.required_labels") ?? [],
    active_states: strList(t.active_states, "tracker.active_states"),
    terminal_states: strList(t.terminal_states, "tracker.terminal_states"),
  };

  // polling
  const p = obj(c.polling, "polling");
  const polling = { interval_ms: int(p.interval_ms, "polling.interval_ms", 30000, { min: 1 }) };

  // workspace
  const w = obj(c.workspace, "workspace");
  const rawRoot = str(w.root, "workspace.root");
  let root = rawRoot ? resolvePathValue(rawRoot, env) : path.join(os.tmpdir(), "symphony_workspaces");
  if (root === "") throw new SymphonyError("invalid_config", "workspace.root resolved to an empty path");
  root = path.resolve(workflowDir, root);

  // hooks
  const h = obj(c.hooks, "hooks");
  const hooks: HooksConfig = {
    after_create: str(h.after_create, "hooks.after_create"),
    before_run: str(h.before_run, "hooks.before_run"),
    after_run: str(h.after_run, "hooks.after_run"),
    before_remove: str(h.before_remove, "hooks.before_remove"),
    timeout_ms: int(h.timeout_ms, "hooks.timeout_ms", 60000, { min: 1 }),
  };

  // agent
  const a = obj(c.agent, "agent");
  const byState: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(a.max_concurrent_agents_by_state, "agent.max_concurrent_agents_by_state"))) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) byState[normState(k)] = n; // invalid entries ignored
  }
  const agent = {
    max_concurrent_agents: int(a.max_concurrent_agents, "agent.max_concurrent_agents", 10, { min: 0 }),
    max_turns: int(a.max_turns, "agent.max_turns", 20, { min: 1 }),
    max_retry_backoff_ms: int(a.max_retry_backoff_ms, "agent.max_retry_backoff_ms", 300000, { min: 0 }),
    max_concurrent_agents_by_state: byState,
  };

  // claude (this implementation's coding-agent section). Timeout fields fall back to the core
  // `codex.*` keys so a stock Symphony WORKFLOW.md keeps its timeout semantics.
  const codex = obj(c.codex, "codex");
  const cl = obj(c.claude, "claude");
  const pick = (k: string) => (cl[k] !== undefined ? cl[k] : codex[k]);
  const envMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(cl.env, "claude.env"))) {
    if (typeof v !== "string") throw new SymphonyError("invalid_config", `claude.env.${k} must be a string`);
    envMap[k] = v;
  }
  const command = str(cl.command, "claude.command") ?? "claude";
  const claude: ClaudeConfig = {
    command,
    model: str(cl.model, "claude.model"),
    permission_mode: str(cl.permission_mode, "claude.permission_mode") ?? "bypassPermissions",
    permission_prompts: str(cl.permission_prompts, "claude.permission_prompts") ?? "none",
    allowed_tools: strList(cl.allowed_tools, "claude.allowed_tools") ?? [],
    disallowed_tools: strList(cl.disallowed_tools, "claude.disallowed_tools") ?? ["AskUserQuestion"],
    append_system_prompt: str(cl.append_system_prompt, "claude.append_system_prompt"),
    max_budget_usd:
      cl.max_budget_usd === undefined || cl.max_budget_usd === null
        ? null
        : typeof cl.max_budget_usd === "number" && cl.max_budget_usd > 0
          ? cl.max_budget_usd
          : (() => {
              throw new SymphonyError("invalid_config", "claude.max_budget_usd must be a positive number");
            })(),
    strict_mcp_config: bool(cl.strict_mcp_config, "claude.strict_mcp_config", false),
    extra_args: strList(cl.extra_args, "claude.extra_args") ?? [],
    env: envMap,
    turn_timeout_ms: int(pick("turn_timeout_ms"), "claude.turn_timeout_ms", 3600000, { min: 1 }),
    read_timeout_ms: int(pick("read_timeout_ms"), "claude.read_timeout_ms", 60000, { min: 1 }),
    stall_timeout_ms: int(pick("stall_timeout_ms"), "claude.stall_timeout_ms", 300000),
  };

  // server (HTTP extension §13.7)
  const s = obj(c.server, "server");
  const server = {
    port: s.port === undefined || s.port === null ? null : int(s.port, "server.port", 0, { min: 0 }),
    host: str(s.host, "server.host") ?? "127.0.0.1",
  };

  // logging (extension)
  const l = obj(c.logging, "logging");
  const logFile = str(l.file, "logging.file");
  const agentLogDir = str(l.agent_log_dir, "logging.agent_log_dir");
  const logging = {
    file: logFile ? path.resolve(workflowDir, resolvePathValue(logFile, env)) : null,
    level: str(l.level, "logging.level"),
    agent_log_dir: agentLogDir
      ? path.resolve(workflowDir, resolvePathValue(agentLogDir, env))
      : path.join(os.tmpdir(), "symphony_logs"),
  };

  return {
    workflow_path: path.resolve(workflowPath),
    workflow_dir: workflowDir,
    tracker,
    polling,
    workspace: { root },
    hooks,
    agent,
    claude,
    server,
    logging,
  };
}

/** Dispatch preflight checks independent of the adapter (SPEC §6.3). */
export function validateCoreConfig(cfg: ServiceConfig): void {
  if (!cfg.tracker.kind) throw new SymphonyError("unsupported_tracker_kind", "tracker.kind is required");
  if (!cfg.claude.command.trim()) throw new SymphonyError("missing_agent_command", "claude.command must be non-empty");
}
