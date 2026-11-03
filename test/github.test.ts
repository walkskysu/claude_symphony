// GitHub adapter (SPEC §17.3) against a mocked fetch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrackerError } from "../src/errors.ts";
import { GitHubAdapter, parseGitHubProvider, parseNextLink, validBranch } from "../src/tracker/github.ts";
import { mkIssue, quietLogger } from "./helpers.ts";

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function mockFetch(route: Route) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", url: url.toString(), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = route(url, init) ?? { status: 404, body: { message: "Not Found" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const raw = (n: number, over: Record<string, unknown> = {}) => ({
  id: 1000 + n,
  node_id: `I_${n}`,
  number: n,
  title: `Issue ${n}`,
  body: "body",
  state: "open",
  html_url: `https://github.com/o/r/issues/${n}`,
  repository_url: "https://api.github.com/repos/o/r",
  labels: [{ name: "status:Todo" }, { name: " Bug " }],
  assignees: [{ login: "alice" }],
  created_at: "2026-01-0" + Math.min(9, n) + "T00:00:00Z",
  updated_at: "2026-01-10T00:00:00Z",
  ...over,
});

function adapter(fn: typeof fetch, provider: Record<string, unknown> = {}) {
  return new GitHubAdapter({
    provider: parseGitHubProvider({ owner: "o", repo: "r", token: "$GH_T", ...provider }, { GH_T: "secret-token" }),
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Closed", "Done"],
    log: quietLogger(),
    fetchFn: fn,
  });
}

describe("github provider config", () => {
  it("requires owner/repo and a token", () => {
    assert.throws(() => parseGitHubProvider({ owner: "o" }, {}), (e: TrackerError) => e.category === "invalid_tracker_config");
    assert.throws(() => parseGitHubProvider({ owner: "o", repo: "r", token: "$EMPTY" }, { EMPTY: "" }), (e: TrackerError) => e.category === "missing_tracker_secret");
    const c = parseGitHubProvider({ repository: "acme/app" }, { GH_TOKEN: "t" });
    assert.equal(c.owner, "acme");
    assert.equal(c.repo, "app");
    assert.equal(c.token, "t");
    assert.equal(c.token_env, "GH_TOKEN");
  });
});

describe("github adapter reads", () => {
  it("empty inputs make no requests", async () => {
    const m = mockFetch(() => ({ body: [] }));
    const a = adapter(m.fn);
    assert.deepEqual(await a.fetchIssuesByStates([]), []);
    assert.deepEqual(await a.fetchIssuesByIds([]), []);
    assert.equal(m.calls.length, 0);
  });

  it("paginates in order, normalizes, omits PRs and malformed records", async () => {
    const m = mockFetch((url) => {
      if (url.pathname === "/repos/o/r/issues" && url.searchParams.get("labels") === "status:Todo") {
        if (url.searchParams.get("page") === "2") return { body: [raw(3), { number: 4, title: "" }] };
        return {
          body: [raw(1, { labels: [{ name: "status:Todo" }, { name: "priority:2" }] }), raw(2, { pull_request: {} })],
          headers: { link: '<https://api.github.com/repos/o/r/issues?labels=status%3ATodo&page=2>; rel="next"' },
        };
      }
      return { body: [] };
    });
    const issues = await adapter(m.fn).fetchIssuesByStates(["Todo"]);
    assert.deepEqual(issues.map((i) => i.identifier), ["r-1", "r-3"]);
    const i1 = issues[0];
    assert.equal(i1.id, "1");
    assert.equal(i1.state, "Todo");
    assert.equal(i1.priority, 2);
    assert.deepEqual(i1.labels, ["status:todo", "priority:2"]);
    assert.equal(i1.created_at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual((i1.native_ref as Record<string, unknown>).node_id, "I_1");
    assert.equal(issues[1].labels.includes("bug"), true);
    assert.equal(m.calls[0].url.includes("Authorization"), false);
  });

  it("derives states: closed, open default, ambiguous labels non-dispatchable, assignee rule", async () => {
    const a = adapter(mockFetch(() => undefined).fn, { assignee: "Alice" });
    assert.equal(a.normalize(raw(1, { state: "closed" })).issue!.state, "Closed");
    assert.equal(a.normalize(raw(1, { labels: [] })).issue!.state, "Open");
    const amb = a.normalize(raw(1, { labels: [{ name: "status:Todo" }, { name: "status:In Progress" }] })).issue!;
    assert.equal(amb.dispatchable, false);
    assert.equal(a.normalize(raw(1)).issue!.dispatchable, true);
    assert.equal(a.normalize(raw(1, { assignees: [] })).issue!.dispatchable, false);
  });

  it("fetch by ids: omits 404 and transferred issues, fails on malformed", async () => {
    const m = mockFetch((url) => {
      if (url.pathname === "/repos/o/r/issues/1") return { body: raw(1) };
      if (url.pathname === "/repos/o/r/issues/2") return { status: 404, body: { message: "Not Found" } };
      if (url.pathname === "/repos/o/r/issues/3") return { body: raw(3, { repository_url: "https://api.github.com/repos/x/y" }) };
      if (url.pathname === "/repos/o/r/issues/5") return { body: { number: 5, state: "open" } };
      return undefined;
    });
    const a = adapter(m.fn);
    const got = await a.fetchIssuesByIds(["1", "2", "3", "1"]);
    assert.deepEqual(got.map((i) => i.id), ["1"]);
    await assert.rejects(a.fetchIssuesByIds(["5"]), (e: TrackerError) => e.category === "tracker_response");
  });

  it("maps errors: status, rate limit, transport", async () => {
    const a1 = adapter(mockFetch(() => ({ status: 500, body: { message: "oops" } })).fn);
    await assert.rejects(a1.fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_status");
    const a2 = adapter(mockFetch(() => ({ status: 403, body: { message: "rate" }, headers: { "x-ratelimit-remaining": "0", "retry-after": "7" } })).fn);
    await assert.rejects(a2.fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_rate_limited" && e.retryAfterMs === 7000);
    const a3 = adapter((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    await assert.rejects(a3.fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_request");
    const a4 = adapter(mockFetch(() => ({ body: { not: "array" } })).fn);
    await assert.rejects(a4.fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_response");
  });

  it("enforces max_pages", async () => {
    const m = mockFetch(() => ({ body: [], headers: { link: '<https://api.github.com/repos/o/r/issues?page=9>; rel="next"' } }));
    await assert.rejects(adapter(m.fn, { max_pages: 2 }).fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_pagination");
  });

  it("declares secret env names", () => {
    const a = adapter(mockFetch(() => undefined).fn);
    assert.ok(a.secretEnvironmentNames().includes("GITHUB_TOKEN"));
    assert.ok(a.secretEnvironmentNames().includes("GH_T"));
  });
});

describe("github agent tools", () => {
  const ctx = { issue: mkIssue({ id: "7", native_ref: { number: 7 } }), workspacePath: "/tmp/x" };

  it("set_state swaps state labels and closes/reopens", async () => {
    const m = mockFetch((url, init) => {
      if (url.pathname === "/repos/o/r/issues/7" && (init.method ?? "GET") === "GET") return { body: raw(7) };
      return { body: {} };
    });
    const a = adapter(m.fn);
    const r = await a.executeAgentTool("github_issue_set_state", { state: "Human Review" }, ctx);
    assert.equal(r.ok, true);
    const muts = m.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${new URL(c.url).pathname}`);
    assert.deepEqual(muts, ["DELETE /repos/o/r/issues/7/labels/status%3ATodo", "POST /repos/o/r/issues/7/labels"]);
    m.calls.length = 0;
    await a.executeAgentTool("github_issue_set_state", { state: "closed" }, ctx);
    assert.ok(m.calls.some((c) => c.method === "PATCH" && (c.body as { state: string }).state === "closed"));
  });

  it("validates args and rejects unknown tools / state labels via labels tool", async () => {
    const a = adapter(mockFetch(() => ({ body: {} })).fn);
    assert.equal((await a.executeAgentTool("github_issue_comment", {}, ctx)).ok, false);
    const u = await a.executeAgentTool("nope", {}, ctx);
    assert.equal(u.ok === false && u.error.code, "unsupported_tool");
    const l = await a.executeAgentTool("github_issue_labels", { add: ["status:Done"] }, ctx);
    assert.equal(l.ok === false && l.error.code, "invalid_arguments");
  });

  it("pr_create appends Closes and uses default branch", async () => {
    const m = mockFetch((url) => {
      if (url.pathname === "/repos/o/r") return { body: { clone_url: "https://github.com/o/r.git", default_branch: "trunk" } };
      if (url.pathname === "/repos/o/r/pulls") return { status: 201, body: { number: 9, html_url: "u" } };
      return undefined;
    });
    const r = await adapter(m.fn).executeAgentTool("github_pr_create", { title: "t", head: "symphony/r-7", body: "b" }, ctx);
    assert.equal(r.ok, true);
    const post = m.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(post.body, { title: "t", head: "symphony/r-7", base: "trunk", body: "b\n\nCloses #7", draft: false });
  });

  it("push refuses protected branches and force without permission", async () => {
    const m = mockFetch((url) => (url.pathname === "/repos/o/r" ? { body: { clone_url: "https://github.com/o/r.git", default_branch: "trunk" } } : undefined));
    const a = adapter(m.fn);
    const r1 = await a.executeAgentTool("github_git_push", { branch: "trunk" }, ctx);
    assert.equal(r1.ok === false && r1.error.code, "forbidden");
    const r2 = await a.executeAgentTool("github_git_push", { branch: "feature", force: true }, ctx);
    assert.equal(r2.ok === false && r2.error.code, "forbidden");
    const r3 = await a.executeAgentTool("github_git_push", { branch: "../x" }, ctx);
    assert.equal(r3.ok === false && r3.error.code, "invalid_arguments");
  });

  it("helpers", () => {
    assert.equal(parseNextLink('<a>; rel="prev", <b>; rel="next"'), "b");
    assert.equal(parseNextLink(null), null);
    assert.equal(validBranch("symphony/r-1"), true);
    assert.equal(validBranch("-x"), false);
  });
});
