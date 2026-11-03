// Core conformance: workflow loader, config layer, templates, workspaces (SPEC §17.1, §17.2).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildConfig } from "../src/config.ts";
import { SymphonyError } from "../src/errors.ts";
import { renderPrompt } from "../src/template.ts";
import { loadWorkflow, parseWorkflow, resolveWorkflowPath, WorkflowWatcher } from "../src/workflow.ts";
import { WorkspaceManager, workspaceKey, workspacePathFor } from "../src/workspace.ts";
import { mkIssue, quietLogger, tmpDir, waitFor } from "./helpers.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as SymphonyError).category;
  }
  return null;
};

describe("workflow loader", () => {
  it("path precedence: explicit, else cwd WORKFLOW.md", () => {
    assert.equal(resolveWorkflowPath("x/W.md", "/r"), "/r/x/W.md");
    assert.equal(resolveWorkflowPath(undefined, "/r"), "/r/WORKFLOW.md");
  });
  it("splits front matter and trims body", () => {
    const wf = parseWorkflow("---\ntracker:\n  kind: github\n---\n\n  Hello {{ issue.title }}  \n\n");
    assert.deepEqual(wf.config, { tracker: { kind: "github" } });
    assert.equal(wf.prompt_template, "Hello {{ issue.title }}");
  });
  it("no front matter => whole body, empty config", () => {
    const wf = parseWorkflow("just a prompt\n");
    assert.deepEqual(wf.config, {});
    assert.equal(wf.prompt_template, "just a prompt");
  });
  it("typed errors", () => {
    assert.equal(code(() => parseWorkflow("---\n- a\n- b\n---\nx")), "workflow_front_matter_not_a_map");
    assert.equal(code(() => parseWorkflow("---\na: [\n---\nx")), "workflow_parse_error");
    assert.equal(code(() => parseWorkflow("---\na: 1\n")), "workflow_parse_error");
    assert.equal(code(() => loadWorkflow("/nonexistent/WORKFLOW.md")), "missing_workflow_file");
  });
  it("watcher detects changes", async () => {
    const d = tmpDir();
    const p = path.join(d, "WORKFLOW.md");
    fs.writeFileSync(p, "a");
    let n = 0;
    const w = new WorkflowWatcher(p, () => n++, 100);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(p, "bb");
    await waitFor(() => n > 0, 3000);
    w.close();
  });
});

describe("config layer", () => {
  const wfp = "/repo/WORKFLOW.md";
  it("applies defaults", () => {
    const c = buildConfig({ config: { tracker: { kind: "github" } }, prompt_template: "" }, wfp, {});
    assert.equal(c.polling.interval_ms, 30000);
    assert.equal(c.workspace.root, path.join(os.tmpdir(), "symphony_workspaces"));
    assert.equal(c.hooks.timeout_ms, 60000);
    assert.equal(c.agent.max_concurrent_agents, 10);
    assert.equal(c.agent.max_turns, 20);
    assert.equal(c.agent.max_retry_backoff_ms, 300000);
    assert.equal(c.claude.command, "claude");
    assert.equal(c.claude.turn_timeout_ms, 3600000);
    assert.equal(c.claude.stall_timeout_ms, 300000);
    assert.deepEqual(c.tracker.provider, {});
    assert.equal(c.server.port, null);
  });
  it("resolves $VAR and ~ for paths; relative to workflow dir", () => {
    const env = { WS: "/data/ws" };
    assert.equal(buildConfig({ config: { workspace: { root: "$WS" } }, prompt_template: "" }, wfp, env).workspace.root, "/data/ws");
    assert.equal(buildConfig({ config: { workspace: { root: "~/w" } }, prompt_template: "" }, wfp, env).workspace.root, path.join(os.homedir(), "w"));
    assert.equal(buildConfig({ config: { workspace: { root: "rel/ws" } }, prompt_template: "" }, wfp, env).workspace.root, "/repo/rel/ws");
  });
  it("preserves provider keys and the command string", () => {
    const c = buildConfig(
      { config: { tracker: { kind: "github", provider: { owner: "o", custom: { x: 1 } } }, claude: { command: "FOO=1 claude --x $HOME" } }, prompt_template: "" },
      wfp,
      {},
    );
    assert.deepEqual(c.tracker.provider, { owner: "o", custom: { x: 1 } });
    assert.equal(c.claude.command, "FOO=1 claude --x $HOME");
  });
  it("normalizes per-state limits and ignores invalid entries", () => {
    const c = buildConfig(
      { config: { agent: { max_concurrent_agents_by_state: { " In Progress ": 2, Todo: 0, X: "abc", Y: "3" } } }, prompt_template: "" },
      wfp,
      {},
    );
    assert.deepEqual(c.agent.max_concurrent_agents_by_state, { "in progress": 2, y: 3 });
  });
  it("falls back to codex.* timeouts", () => {
    const c = buildConfig({ config: { codex: { turn_timeout_ms: 5, stall_timeout_ms: 0 } }, prompt_template: "" }, wfp, {});
    assert.equal(c.claude.turn_timeout_ms, 5);
    assert.equal(c.claude.stall_timeout_ms, 0);
  });
  it("rejects invalid values", () => {
    assert.equal(code(() => buildConfig({ config: { agent: { max_turns: 0 } }, prompt_template: "" }, wfp, {})), "invalid_config");
    assert.equal(code(() => buildConfig({ config: { hooks: { timeout_ms: "x" } }, prompt_template: "" }, wfp, {})), "invalid_config");
  });
});

describe("prompt template", () => {
  it("renders issue and attempt, iterates labels", () => {
    const out = renderPrompt("{{ issue.identifier }} {% for l in issue.labels %}[{{ l }}]{% endfor %} a={{ attempt }}", {
      issue: mkIssue({ labels: ["bug", "ui"] }),
      attempt: 2,
    });
    assert.equal(out, "T-1 [bug][ui] a=2");
    assert.equal(renderPrompt("{% if attempt %}retry{% else %}first{% endif %}", { issue: mkIssue(), attempt: null }), "first");
  });
  it("fails on unknown variables and filters", () => {
    assert.equal(code(() => renderPrompt("{{ nope }}", { issue: mkIssue(), attempt: null })), "template_render_error");
    assert.equal(code(() => renderPrompt("{{ issue.nope }}", { issue: mkIssue(), attempt: null })), "template_render_error");
    const c = code(() => renderPrompt("{{ issue.title | bogus }}", { issue: mkIssue(), attempt: null }));
    assert.ok(c === "template_render_error" || c === "template_parse_error");
    assert.equal(code(() => renderPrompt("{% if %}", { issue: mkIssue(), attempt: null })), "template_parse_error");
  });
});

describe("workspace manager", () => {
  it("sanitizes identifiers with collision-resistant hash", () => {
    assert.equal(workspaceKey("ABC-123"), "ABC-123");
    const a = workspaceKey("a/b");
    const b = workspaceKey("a:b");
    assert.match(a, /^a_b-[0-9a-f]{16}$/);
    assert.notEqual(a, b);
    assert.equal(workspaceKey("a/b"), a);
    assert.match(workspaceKey(".."), /^\.\.-[0-9a-f]{16}$/);
  });
  it("keeps paths inside the root", () => {
    const root = tmpDir();
    assert.equal(workspacePathFor(root, "../../etc"), path.join(root, workspaceKey("../../etc")));
    assert.ok(workspacePathFor(root, "../../etc").startsWith(root + path.sep));
  });

  function mgr(root: string, hooks: Record<string, string | number | null> = {}) {
    return new WorkspaceManager({
      root: () => root,
      hooks: () => ({ after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 2000, ...hooks }) as never,
      log: quietLogger(),
    });
  }

  it("creates once, reuses, runs after_create only on creation", async () => {
    const root = tmpDir();
    const m = mgr(root, { after_create: "echo x >> created.txt" });
    const w1 = await m.createForIssue("I-1");
    assert.equal(w1.created_now, true);
    const w2 = await m.createForIssue("I-1");
    assert.equal(w2.created_now, false);
    assert.equal(fs.readFileSync(path.join(w1.path, "created.txt"), "utf8"), "x\n");
  });
  it("after_create failure aborts creation and removes the dir", async () => {
    const root = tmpDir();
    const m = mgr(root, { after_create: "exit 4" });
    await assert.rejects(m.createForIssue("I-2"), (e: SymphonyError) => e.category === "hook_failed");
    assert.equal(fs.existsSync(path.join(root, "I-2")), false);
  });
  it("before_run failure/timeouts are fatal; after_run/before_remove are ignored", async () => {
    const root = tmpDir();
    const m = mgr(root, { before_run: "sleep 5", after_run: "exit 1", before_remove: "exit 1", timeout_ms: 200 });
    const w = await m.createForIssue("I-3");
    await assert.rejects(m.runHook("before_run", w.path, "I-3"), (e: SymphonyError) => e.category === "hook_timeout");
    await m.runHook("after_run", w.path, "I-3");
    assert.equal(await m.removeWorkspace("I-3"), true);
    assert.equal(fs.existsSync(w.path), false);
  });
  it("non-directory at workspace path fails safely", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "I-4"), "file");
    await assert.rejects(mgr(root).createForIssue("I-4"), (e: SymphonyError) => e.category === "workspace_error");
  });
});
