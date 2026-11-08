// Orchestrator + Claude client + tool bridge + HTTP (SPEC §17.4–§17.6), using fake-claude.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildClaudeCommand, ClaudeSession } from "../src/agent/claude.ts";
import { buildChildEnv } from "../src/agent/runner.ts";
import { buildConfig } from "../src/config.ts";
import type { SymphonyError } from "../src/errors.ts";
import { startHttpServer } from "../src/http.ts";
import { Orchestrator, retryDelayMs, sortForDispatch } from "../src/orchestrator.ts";
import type { AgentEvent } from "../src/types.ts";
import { FAKE_CLAUDE, MemoryTracker, mkIssue, quietLogger, tmpDir, waitFor, writeWorkflow } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_TOOL;
  delete process.env.FAKE_TOOL_ARGS;
  delete process.env.FAKE_RECORD;
});

function front(dir: string, extra = "", more: { tracker?: string; agent?: string } = {}) {
  return `tracker:
  kind: memory
${more.tracker ?? ""}
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 60000
workspace:
  root: ${path.join(dir, "ws")}
logging:
  agent_log_dir: ${path.join(dir, "logs")}
agent:
  max_turns: 3
  max_retry_backoff_ms: 300000
${more.agent ?? ""}
claude:
  command: node ${FAKE_CLAUDE}
  read_timeout_ms: 5000
${extra}`;
}

async function startOrch(tracker: MemoryTracker, extra = "", body?: string, more: { tracker?: string; agent?: string } = {}) {
  const dir = tmpDir();
  const wf = writeWorkflow(dir, front(dir, extra, more), body);
  const orch = new Orchestrator({
    workflowPath: wf,
    log: quietLogger(),
    trackerBuilder: (cfg) => ({ adapter: tracker, activeStates: cfg.tracker.active_states!, terminalStates: cfg.tracker.terminal_states! }),
    watchPollMs: 100,
  });
  await orch.start();
  cleanups.push(() => orch.stop());
  return { orch, dir, wf };
}

describe("scheduling helpers", () => {
  it("sorts by priority bucket, then created_at, then identifier", () => {
    const issues = [
      mkIssue({ id: "a", identifier: "A", priority: null, created_at: "2026-01-01T00:00:00Z" }),
      mkIssue({ id: "b", identifier: "B", priority: 2, created_at: "2026-01-03T00:00:00Z" }),
      mkIssue({ id: "c", identifier: "C", priority: 1, created_at: "2026-01-05T00:00:00Z" }),
      mkIssue({ id: "d", identifier: "D", priority: 7, created_at: "2025-01-01T00:00:00Z" }),
      mkIssue({ id: "e", identifier: "E", priority: 2, created_at: "2026-01-02T00:00:00Z" }),
      mkIssue({ id: "f", identifier: "F", priority: 2, created_at: null }),
    ];
    assert.deepEqual(sortForDispatch(issues).map((i) => i.identifier), ["C", "E", "B", "F", "D", "A"]);
  });
  it("backoff is 10s exponential with cap", () => {
    assert.equal(retryDelayMs(1, 300000), 10000);
    assert.equal(retryDelayMs(2, 300000), 20000);
    assert.equal(retryDelayMs(3, 300000), 40000);
    assert.equal(retryDelayMs(10, 300000), 300000);
    assert.equal(retryDelayMs(3, 15000), 15000);
  });
  it("child env drops tracker secrets", () => {
    const env = buildChildEnv({ GITHUB_TOKEN: "x", KEEP: "1", CLAUDECODE: "1" }, ["GITHUB_TOKEN"], { A: "b" });
    assert.deepEqual(env, { KEEP: "1", A: "b" });
  });
  it("builds the claude command with protocol flags", () => {
    const cfg = buildConfig({ config: { claude: { model: "sonnet", allowed_tools: ["Bash(git *)"] } }, prompt_template: "" }, "/x/W.md", {}).claude;
    const cmd = buildClaudeCommand(cfg, "tid", "R-1: it's", '{"a":1}');
    assert.match(cmd, /^claude -p --input-format stream-json --output-format stream-json --verbose --session-id tid/);
    assert.match(cmd, /--permission-mode bypassPermissions --permission-prompts none/);
    assert.match(cmd, /--name 'R-1: it'\\''s'/);
    assert.match(cmd, /--allowedTools 'Bash\(git \*\),mcp__symphony'/);
    assert.match(cmd, /--disallowedTools AskUserQuestion/);
  });
});

describe("claude session client", () => {
  function session(dir: string, events: AgentEvent[], over: Record<string, unknown> = {}) {
    const cfg = { ...buildConfig({ config: { claude: { command: `node ${FAKE_CLAUDE}` } }, prompt_template: "" }, "/x/W.md", {}).claude, ...over };
    return new ClaudeSession({ cfg, cwd: dir, env: process.env, title: "t", mcpConfigJson: null, logFile: path.join(dir, "a.log"), log: quietLogger(), onEvent: (e) => events.push(e) });
  }
  it("runs multiple turns on one live session and reports absolute usage", async () => {
    const dir = tmpDir();
    const events: AgentEvent[] = [];
    const s = session(dir, events);
    await s.start();
    const r1 = await s.runTurn("hello");
    const r2 = await s.runTurn("continue");
    await s.stop();
    assert.equal(r1.session_id, `${s.threadId}-turn-1`);
    assert.equal(r2.session_id, `${s.threadId}-turn-2`);
    assert.equal(events.filter((e) => e.event === "session_started").length, 1);
    const done = events.filter((e) => e.event === "turn_completed");
    assert.deepEqual(done.map((e) => e.usage!.total_tokens), [170, 340]);
    // Live usage while a turn runs: thread total so far + the in-progress API message (same id
    // repeated across content blocks is not double counted), replaced by the result usage.
    const live = events.filter((e) => e.event === "notification" && e.usage).map((e) => e.usage!.total_tokens);
    assert.deepEqual(live, [85, 90, 255, 260]);
    // total_cost_usd is session-cumulative: the session total is the latest value, not a sum.
    assert.deepEqual(done.map((e) => e.cost_usd), [0.01, 0.02]);
    assert.deepEqual([r1.cost_usd, r2.cost_usd].map((c) => Math.round(c! * 1000) / 1000), [0.01, 0.01]);
    assert.ok(events.some((e) => e.rate_limits));
    assert.ok(fs.readFileSync(path.join(dir, "a.log"), "utf8").includes("[stderr] fake-claude diagnostics"));
  });
  it("maps failures: turn_failed, port_exit, codex_not_found, turn_timeout", async () => {
    const dir = tmpDir();
    process.env.FAKE_MODE = "fail";
    let s = session(dir, []);
    await s.start();
    await assert.rejects(s.runTurn("x"), (e: SymphonyError) => e.category === "turn_failed");
    await s.stop();

    process.env.FAKE_MODE = "exit";
    s = session(dir, []);
    await assert.rejects(s.start().then(() => s.runTurn("x")), (e: SymphonyError) => e.category === "port_exit");
    await s.stop();

    s = session(dir, [], { command: "definitely-not-a-binary-xyz" });
    await assert.rejects(s.start().then(() => s.runTurn("x")), (e: SymphonyError) => e.category === "codex_not_found");

    process.env.FAKE_MODE = "silent_after_init";
    s = session(dir, [], { turn_timeout_ms: 300 });
    await s.start();
    await assert.rejects(s.runTurn("x"), (e: SymphonyError) => e.category === "turn_timeout");
    await s.stop();

    process.env.FAKE_MODE = "hang";
    s = session(dir, [], { read_timeout_ms: 5000, turn_timeout_ms: 300 });
    await s.start();
    await assert.rejects(s.runTurn("x"), (e: SymphonyError) => e.category === "turn_timeout");
    await s.stop();
  });
});

describe("orchestrator", () => {
  it("dispatches, runs continuation turns, exits normally and schedules continuation retry", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1", identifier: "T-1" })]);
    const rec = path.join(tmpDir(), "rec.jsonl");
    process.env.FAKE_RECORD = rec;
    process.env.GITHUB_TOKEN = "leak-me-not";
    process.env.MEMORY_TRACKER_SECRET = "s3cret";
    cleanups.push(() => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.MEMORY_TRACKER_SECRET;
    });
    const { orch, dir } = await startOrch(tracker);
    await waitFor(() => orch.running.size === 1);
    await waitFor(() => orch.retryAttempts.has("1"), 15000);
    const r = orch.retryAttempts.get("1")!;
    assert.equal(r.attempt, 1);
    assert.equal(r.error, null);
    assert.ok(r.due_at_ms - performance.now() <= 1000);
    assert.ok(orch.completed.has("1"));
    assert.equal(orch.codexTotals.total_tokens, 170 * 3);
    // One snapshot per rate-limit window: the seven_day event doesn't replace the five_hour one.
    assert.deepEqual([...orch.rateLimits.keys()].sort(), ["five_hour", "seven_day"]);
    assert.equal((orch.rateLimits.get("seven_day") as { status: string }).status, "allowed_warning");

    const lines = fs.readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const start = lines.find((l) => l.kind === "start");
    assert.equal(start.cwd, path.join(dir, "ws", "T-1"));
    assert.equal(start.env.SYMPHONY_ISSUE_IDENTIFIER, "T-1");
    const prompts = lines.filter((l) => l.kind === "stdin").map((l) => l.msg.message.content);
    assert.equal(prompts.length, 3); // max_turns
    assert.equal(prompts[0], "Work on T-1: Test issue attempt=");
    assert.match(prompts[1], /^Continue working on T-1/);
    assert.ok(fs.existsSync(path.join(dir, "logs", "T-1", "latest.log")));
  });

  it("passes adapter issueEnvironment to hooks and the agent", async () => {
    const tracker = Object.assign(new MemoryTracker([mkIssue({ id: "o/r#1", identifier: "r-1" })]), {
      issueEnvironment: (i: { id: string }) => ({ SYMPHONY_ISSUE_REPO: i.id.split("#")[0] }),
    });
    const rec = path.join(tmpDir(), "rec.jsonl");
    process.env.FAKE_RECORD = rec;
    const hooks = 'hooks:\n  after_create: |\n    echo "$SYMPHONY_ISSUE_REPO" > repo.txt';
    const { orch, dir } = await startOrch(tracker, hooks);
    await waitFor(() => orch.retryAttempts.has("o/r#1"), 15000);
    assert.equal(fs.readFileSync(path.join(dir, "ws", "r-1", "repo.txt"), "utf8").trim(), "o/r");
    const start = fs.readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.kind === "start");
    assert.equal(start.env.SYMPHONY_ISSUE_REPO, "o/r");
  });

  it("does not dispatch non-dispatchable, label-missing, or already-claimed issues; respects per-state limits", async () => {
    const tracker = new MemoryTracker([
      mkIssue({ id: "1", dispatchable: false, labels: ["agent"] }),
      mkIssue({ id: "2", labels: ["other"] }),
      mkIssue({ id: "3", labels: ["agent"], state: "In Progress", created_at: "2026-01-01T00:00:00Z" }),
      mkIssue({ id: "4", labels: ["AGENT "], state: "In Progress", created_at: "2026-01-02T00:00:00Z" }),
    ]);
    process.env.FAKE_MODE = "hang";
    const { orch } = await startOrch(tracker, "  stall_timeout_ms: 0\n  turn_timeout_ms: 600000", undefined, {
      tracker: "  required_labels: [' Agent ']",
      agent: "  max_concurrent_agents_by_state:\n    ' In Progress': 1",
    });
    await waitFor(() => orch.running.size === 1);
    await orch.tick();
    assert.deepEqual([...orch.running.keys()], ["3"]);
    assert.equal(orch.shouldDispatch(tracker.issues.get("4")!), false); // per-state slot exhausted
    assert.equal(orch.shouldDispatch(tracker.issues.get("3")!), false); // already running/claimed
    assert.equal(orch.issueRoutable(tracker.issues.get("1")!), false);
    assert.equal(orch.issueRoutable(tracker.issues.get("2")!), false);
    assert.equal(orch.issueRoutable(tracker.issues.get("4")!), true);
  });

  it("reconciliation: terminal state stops worker and cleans workspace; inactive stops without cleanup", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1", identifier: "T-1" }), mkIssue({ id: "2", identifier: "T-2" })]);
    process.env.FAKE_MODE = "hang";
    const { orch, dir } = await startOrch(tracker, "  turn_timeout_ms: 600000\n  stall_timeout_ms: 0");
    await waitFor(() => orch.running.size === 2 && [...orch.running.values()].every((e) => e.workspace_path));
    await waitFor(() => fs.existsSync(path.join(dir, "ws", "T-1")) && fs.existsSync(path.join(dir, "ws", "T-2")));
    tracker.set("1", { state: "Done" });
    tracker.set("2", { state: "Backlog" });
    await orch.tick();
    await waitFor(() => orch.running.size === 0, 15000);
    await waitFor(() => !fs.existsSync(path.join(dir, "ws", "T-1")));
    assert.equal(fs.existsSync(path.join(dir, "ws", "T-2")), true);
    assert.equal(orch.claimed.size, 0);
    assert.equal(orch.retryAttempts.size, 0);
    // Only the terminal issue is listed as finished, with its final state and run totals.
    const fin = orch.snapshot().finished;
    assert.deepEqual(fin.map((f) => [f.issue_identifier, f.state, f.runs]), [["T-1", "Done", 1]]);
    assert.equal(fin[0].title, "Test issue");
  });

  it("reconciliation with no running issues is a no-op", async () => {
    const tracker = new MemoryTracker([]);
    const { orch } = await startOrch(tracker);
    await waitFor(() => orch.lastTickAt !== null);
    tracker.calls.length = 0;
    await orch.reconcileRunningIssues();
    assert.equal(tracker.calls.length, 0);
  });

  it("abnormal exit schedules exponential retry with error; stall detection retries", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1" })]);
    process.env.FAKE_MODE = "fail";
    const { orch } = await startOrch(tracker);
    await waitFor(() => orch.retryAttempts.has("1"), 15000);
    const r = orch.retryAttempts.get("1")!;
    assert.equal(r.attempt, 1);
    assert.match(r.error!, /worker exited: turn_failed/);
    assert.ok(r.due_at_ms - performance.now() > 8000);
    const snap = orch.snapshot();
    assert.equal(snap.retrying[0].attempt, 1);
    assert.ok(snap.retrying[0].due_at);
  });

  it("stalled sessions are killed and retried", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1" })]);
    process.env.FAKE_MODE = "hang";
    const { orch } = await startOrch(tracker, "  stall_timeout_ms: 200\n  turn_timeout_ms: 600000");
    await waitFor(() => orch.running.size === 1);
    await new Promise((r) => setTimeout(r, 400));
    await orch.tick();
    await waitFor(() => orch.retryAttempts.has("1"), 15000);
    assert.match(orch.retryAttempts.get("1")!.error!, /stalled/);
  });

  it("dynamic reload: applies valid changes, keeps last good config on invalid ones", async () => {
    const tracker = new MemoryTracker([]);
    const { orch, wf } = await startOrch(tracker);
    fs.writeFileSync(wf, fs.readFileSync(wf, "utf8").replace("interval_ms: 60000", "interval_ms: 1234"));
    await waitFor(() => orch.cfg().polling.interval_ms === 1234, 5000);
    fs.writeFileSync(wf, "---\ntracker: [\n---\n");
    await waitFor(() => orch.lastConfigError !== null, 5000);
    assert.equal(orch.cfg().polling.interval_ms, 1234);
    assert.match(orch.lastConfigError!, /workflow_parse_error/);
  });

  it("agent tools run host-side through the MCP bridge", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1" })]);
    const rec = path.join(tmpDir(), "rec.jsonl");
    process.env.FAKE_RECORD = rec;
    process.env.FAKE_TOOL = "mem_set_state";
    process.env.FAKE_TOOL_ARGS = JSON.stringify({ state: "Human Review" });
    const { orch } = await startOrch(tracker);
    await waitFor(() => tracker.toolCalls.length === 1 && orch.running.size === 0 && orch.lastTickAt !== null, 15000);
    assert.equal(tracker.issues.get("1")!.state, "Human Review");
    const tool = fs.readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.kind === "tool");
    assert.equal(tool.list.result.tools[0].name, "mem_set_state");
    assert.equal(tool.res.result.isError, false);
    // Issue left the active set after turn 1 => only one prompt was sent.
    const prompts = fs.readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "stdin");
    assert.equal(prompts.length, 1);
  });

  it("template errors fail only the attempt", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1" })]);
    const { orch } = await startOrch(tracker, "", "{{ issue.does_not_exist }}");
    await waitFor(() => orch.retryAttempts.has("1"), 15000);
    assert.match(orch.retryAttempts.get("1")!.error!, /template_render_error/);
  });
});

describe("http extension", () => {
  it("serves state, issue detail, refresh, and error envelopes", async () => {
    const tracker = new MemoryTracker([mkIssue({ id: "1", identifier: "T-1" })]);
    process.env.FAKE_MODE = "hang";
    const { orch } = await startOrch(tracker, "  turn_timeout_ms: 600000\n  stall_timeout_ms: 0");
    const srv = await startHttpServer(orch, { port: 0, host: "127.0.0.1", log: quietLogger() });
    cleanups.push(() => srv.close());
    const base = `http://127.0.0.1:${srv.port}`;
    await waitFor(() => orch.running.size === 1);
    const st = await (await fetch(`${base}/api/v1/state`)).json();
    assert.equal(st.counts.running, 1);
    assert.equal(st.running[0].issue_identifier, "T-1");
    assert.ok("codex_totals" in st && "rate_limits" in st);
    // Rate limits are served as {rateLimitType: snapshot}.
    orch.rateLimits.set("five_hour", { status: "allowed", rateLimitType: "five_hour" });
    orch.rateLimits.set("seven_day", { status: "allowed_warning", rateLimitType: "seven_day" });
    const st2 = await (await fetch(`${base}/api/v1/state`)).json();
    assert.deepEqual(Object.keys(st2.rate_limits), ["five_hour", "seven_day"]);
    assert.equal(st2.rate_limits.seven_day.status, "allowed_warning");
    const d = await fetch(`${base}/api/v1/T-1`);
    assert.equal(d.status, 200);
    assert.equal((await d.json()).status, "running");
    const nf = await fetch(`${base}/api/v1/NOPE-9`);
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).error.code, "issue_not_found");
    assert.equal((await fetch(`${base}/api/v1/state`, { method: "POST" })).status, 405);
    const rf = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
    assert.equal(rf.status, 202);
    assert.equal((await rf.json()).queued, true);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>Symphony<\/title>/);
  });
});
