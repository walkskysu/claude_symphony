import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../src/log.ts";
import type { Issue, ToolContext, ToolResult, ToolSpec, TrackerAdapter } from "../src/types.ts";

export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

export function tmpDir(prefix = "symphony-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function quietLogger(): Logger {
  const l = new Logger({ level: "debug" });
  l.setStderr(process.env.TEST_VERBOSE === "1");
  return l;
}

export function mkIssue(over: Partial<Issue> = {}): Issue {
  const id = over.id ?? "1";
  return {
    id,
    native_ref: null,
    identifier: over.identifier ?? `T-${id}`,
    title: "Test issue",
    description: "desc",
    priority: null,
    state: "Todo",
    branch_name: null,
    url: `https://example.test/${id}`,
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    ...over,
  };
}

/** In-memory tracker adapter for orchestrator tests. */
export class MemoryTracker implements TrackerAdapter {
  readonly kind = "memory";
  issues = new Map<string, Issue>();
  calls: { op: string; arg: string[] }[] = [];
  failIds = false;
  failStates = false;
  toolCalls: { name: string; args: unknown; ctx: ToolContext }[] = [];

  constructor(issues: Issue[] = []) {
    for (const i of issues) this.issues.set(i.id, i);
  }
  set(id: string, patch: Partial<Issue>): void {
    const cur = this.issues.get(id)!;
    this.issues.set(id, { ...cur, ...patch });
  }
  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    this.calls.push({ op: "states", arg: states });
    if (states.length === 0) return [];
    if (this.failStates) throw new Error("boom");
    const want = new Set(states.map((s) => s.toLowerCase()));
    return [...this.issues.values()].filter((i) => want.has(i.state.toLowerCase()));
  }
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    this.calls.push({ op: "ids", arg: ids });
    if (ids.length === 0) return [];
    if (this.failIds) throw new Error("boom");
    return ids.map((id) => this.issues.get(id)).filter((x): x is Issue => !!x);
  }
  secretEnvironmentNames(): string[] {
    return ["MEMORY_TRACKER_SECRET"];
  }
  agentToolSpecs(): ToolSpec[] {
    return [{ name: "mem_set_state", description: "set state", mutates: true, inputSchema: { type: "object" } }];
  }
  async executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    this.toolCalls.push({ name, args, ctx });
    const a = args as { state?: string };
    if (name === "mem_set_state" && a.state) {
      this.set(ctx.issue.id, { state: a.state });
      return { ok: true, output: { state: a.state } };
    }
    return { ok: false, error: { code: "invalid_arguments", message: "bad" } };
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 10000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function writeWorkflow(dir: string, front: string, body = "Work on {{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }}"): string {
  const p = path.join(dir, "WORKFLOW.md");
  fs.writeFileSync(p, `---\n${front}\n---\n${body}\n`);
  return p;
}
