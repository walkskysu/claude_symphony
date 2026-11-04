// GitHub adapter (SPEC §17.3) against a mocked fetch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrackerError } from "../src/errors.ts";
import { describeFetchError, GitHubAdapter, parseGitHubProvider, parseNextLink, validBranch } from "../src/tracker/github.ts";
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
    networkRetryDelaysMs: [0, 0],
  });
}

/** Node-style fetch failure: bare "fetch failed" with the real reason in `cause`. */
function netError(code: string): Error {
  const cause = Object.assign(new Error(`read ${code}`), { code });
  return new TypeError("fetch failed", { cause });
}

describe("github provider config", () => {
  it("requires owner/repo and a token", () => {
    assert.throws(() => parseGitHubProvider({ owner: "o" }, {}), (e: TrackerError) => e.category === "invalid_tracker_config");
    assert.throws(() => parseGitHubProvider({ owner: "o", repo: "r", token: "$EMPTY" }, { EMPTY: "" }), (e: TrackerError) => e.category === "missing_tracker_secret");
    const c = parseGitHubProvider({ repository: "acme/app" }, { GH_TOKEN: "t" });
    assert.equal(c.repos[0].owner, "acme");
    assert.equal(c.repos[0].repo, "app");
    assert.equal(c.repos[0].identifier_prefix, "app");
    assert.equal(c.web_url, "https://github.com");
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
    assert.equal(i1.id, "o/r#1");
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
    const got = await a.fetchIssuesByIds(["o/r#1", "o/r#2", "o/r#3", "o/r#1", "1", "x/y#1"]);
    assert.deepEqual(got.map((i) => i.id), ["o/r#1"]);
    await assert.rejects(a.fetchIssuesByIds(["o/r#5"]), (e: TrackerError) => e.category === "tracker_response");
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

describe("github network failures", () => {
  it("describes the underlying cause of a fetch failure", () => {
    assert.equal(describeFetchError(netError("ECONNRESET")), "fetch failed: read ECONNRESET");
    const agg = new TypeError("fetch failed", {
      cause: new AggregateError([Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" }), new Error("other")]),
    });
    assert.equal(describeFetchError(agg), "fetch failed: connect ETIMEDOUT 1.2.3.4:443; other");
    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }) });
    assert.equal(describeFetchError(dns), "fetch failed: ENOTFOUND getaddrinfo failed");
    assert.equal(describeFetchError(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "timed out (The operation was aborted due to timeout)");
  });

  it("retries GETs on network errors and succeeds once the network is back", async () => {
    let failures = 2;
    const m = mockFetch(() => ({ body: [raw(1)] }));
    const fn = (async (input: string | URL, init?: RequestInit) => {
      if (failures-- > 0) throw netError("ECONNRESET");
      return m.fn(input, init);
    }) as typeof fetch;
    const issues = await adapter(fn).fetchIssuesByStates(["Todo"]);
    assert.deepEqual(issues.map((i) => i.id), ["o/r#1"]);
  });

  it("gives up after the retries with the cause and attempt count in the error", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      throw netError("ECONNRESET");
    }) as unknown as typeof fetch;
    await assert.rejects(adapter(fn).fetchIssuesByIds(["o/r#5"]), (e: TrackerError) => {
      assert.equal(e.category, "tracker_request");
      assert.match(e.message, /failed after 3 attempts: fetch failed: read ECONNRESET/);
      return true;
    });
    assert.equal(calls, 3);
  });

  it("never retries mutations (the request may already have been applied)", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      throw netError("ECONNRESET");
    }) as unknown as typeof fetch;
    const a = adapter(fn);
    await assert.rejects(a.request("POST", "/repos/o/r/issues/1/comments", { body: "x" }), (e: TrackerError) => {
      assert.match(e.message, /^GitHub request POST \S+ failed: fetch failed: read ECONNRESET$/);
      return true;
    });
    assert.equal(calls, 1);
  });
});

describe("github agent tools", () => {
  const ctx = { issue: mkIssue({ id: "o/r#7", native_ref: { owner: "o", repo: "r", number: 7 } }), workspacePath: "/tmp/x" };

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

describe("github multi-repo", () => {
  const multi = (fn: typeof fetch, extra: Record<string, unknown> = {}) =>
    new GitHubAdapter({
      provider: parseGitHubProvider(
        {
          owner: "o",
          repositories: ["r", { repository: "acme/web", identifier_prefix: "WEB", protected_branches: ["release"] }],
          token: "t",
          ...extra,
        },
        {},
      ),
      activeStates: ["Todo"],
      terminalStates: ["Closed"],
      log: quietLogger(),
      fetchFn: fn,
    });

  it("parses repositories and rejects duplicates / prefix collisions / mixing", () => {
    const c = parseGitHubProvider({ owner: "o", repositories: ["r", "x/app", { repository: "y/app", identifier_prefix: "y-app" }] }, { GITHUB_TOKEN: "t" });
    assert.deepEqual(c.repos.map((r) => [r.full_name, r.identifier_prefix]), [["o/r", "r"], ["x/app", "app"], ["y/app", "y-app"]]);
    const bad = (p: Record<string, unknown>) =>
      assert.throws(() => parseGitHubProvider({ token: "t", ...p }, {}), (e: TrackerError) => e.category === "invalid_tracker_config");
    bad({ repositories: ["x/app", "y/app"] });
    bad({ repositories: ["x/app", "X/App"] });
    bad({ repositories: ["app"] });
    bad({ repositories: [] });
    bad({ repositories: ["x/a"], repository: "x/b" });
    bad({ repositories: ["x/a"], identifier_prefix: "p" });
    bad({ repositories: [42] });
  });

  it("fetches candidates across repos with repo-scoped ids and identifiers", async () => {
    const m = mockFetch((url) => {
      if (url.pathname === "/repos/o/r/issues") return { body: [raw(1)] };
      if (url.pathname === "/repos/acme/web/issues") return { body: [raw(1, { repository_url: "https://api.github.com/repos/acme/web" })] };
      if (url.pathname === "/repos/acme/web/issues/1") return { body: raw(1, { repository_url: "https://api.github.com/repos/acme/web" }) };
      return undefined;
    });
    const a = multi(m.fn);
    const issues = await a.fetchIssuesByStates(["Todo"]);
    assert.deepEqual(issues.map((i) => [i.id, i.identifier]), [["o/r#1", "r-1"], ["acme/web#1", "WEB-1"]]);
    assert.equal((issues[1].native_ref as Record<string, unknown>).clone_url, "https://github.com/acme/web.git");
    assert.deepEqual(a.issueEnvironment(issues[1]), {
      SYMPHONY_ISSUE_REPO: "acme/web",
      SYMPHONY_ISSUE_REPO_OWNER: "acme",
      SYMPHONY_ISSUE_REPO_NAME: "web",
      SYMPHONY_ISSUE_NUMBER: "1",
      SYMPHONY_REPO_URL: "https://github.com/acme/web.git",
    });
    const byId = await a.fetchIssuesByIds(["ACME/web#1"]);
    assert.equal(byId[0].identifier, "WEB-1");
  });

  it("fails the whole fetch when one repository fails", async () => {
    const m = mockFetch((url) => (url.pathname === "/repos/o/r/issues" ? { body: [raw(1)] } : { status: 500, body: { message: "x" } }));
    await assert.rejects(multi(m.fn).fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_status");
  });

  it("tools act on the issue's own repository and its protected branches", async () => {
    const m = mockFetch((url) => {
      if (url.pathname === "/repos/acme/web") return { body: { clone_url: "https://github.com/acme/web.git", default_branch: "main" } };
      return { body: {} };
    });
    const a = multi(m.fn);
    const issue = mkIssue({ id: "acme/web#3", native_ref: { owner: "acme", repo: "web", number: 3 } });
    await a.executeAgentTool("github_issue_comment", { body: "hi" }, { issue, workspacePath: "/tmp/x" });
    assert.ok(m.calls.some((c) => c.method === "POST" && new URL(c.url).pathname === "/repos/acme/web/issues/3/comments"));
    const r = await a.executeAgentTool("github_git_push", { branch: "release" }, { issue, workspacePath: "/tmp/x" });
    assert.equal(r.ok === false && r.error.code, "forbidden");
    const stray = mkIssue({ id: "z/z#1", native_ref: { owner: "z", repo: "z", number: 1 } });
    const s = await a.executeAgentTool("github_issue_comment", { body: "x" }, { issue: stray, workspacePath: "/tmp/x" });
    assert.equal(s.ok === false && s.error.code, "invalid_context");
  });

  it("derives GHES web url", () => {
    assert.equal(parseGitHubProvider({ repository: "a/b", token: "t", api_url: "https://ghe.example/api/v3" }, {}).web_url, "https://ghe.example");
  });
});

describe("github labels", () => {
  const mk = (fn: typeof fetch, provider: Record<string, unknown> = {}) =>
    new GitHubAdapter({
      provider: parseGitHubProvider(
        { owner: "o", repositories: ["r", "s"], token: "t", allowed_states: ["Human Review"], blocking_labels: ["blocked"], ...provider },
        {},
      ),
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Done"],
      log: quietLogger(),
      fetchFn: fn,
      requiredLabels: ["agent"],
    });

  it("derives wanted labels (no labels for open/closed pseudo-states)", () => {
    const names = mk(mockFetch(() => undefined).fn).wantedLabels().map((l) => l.name);
    assert.deepEqual(names, ["status:Todo", "status:In Progress", "status:Done", "status:Human Review", "agent", "blocked"]);
  });

  it("check reports, startup creates missing labels per repo, apply forces", async () => {
    const created: string[] = [];
    const m = mockFetch((url, init) => {
      if (url.pathname === "/repos/o/r/labels" && (init.method ?? "GET") === "GET") {
        return { body: ["status:todo", "status:In Progress", "status:Done", "status:Human Review", "Agent", "blocked"].map((name) => ({ name })) };
      }
      if (url.pathname === "/repos/o/s/labels" && (init.method ?? "GET") === "GET") return { body: [{ name: "bug" }] };
      if (url.pathname === "/repos/o/s/labels" && init.method === "POST") {
        created.push(JSON.parse(String(init.body)).name);
        return { status: 201, body: {} };
      }
      return undefined;
    });
    const a = mk(m.fn);
    const check = await a.prepare("check");
    assert.equal(check[0], "o/r: all 6 workflow labels present");
    assert.match(check[1], /^o\/s: missing labels: status:Todo, status:In Progress, status:Done, status:Human Review, agent, blocked$/);
    assert.equal(created.length, 0);

    const start = await a.prepare("startup");
    assert.match(start[1], /^o\/s: created labels:/);
    assert.equal(created.length, 6);
    const post = m.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(Object.keys(post.body as object).sort(), ["color", "description", "name"]);

    created.length = 0;
    const off = mk(m.fn, { ensure_labels: false });
    assert.match((await off.prepare("startup"))[1], /missing labels/);
    assert.equal(created.length, 0);
    assert.match((await off.prepare("apply"))[1], /created labels/);
    assert.equal(created.length, 6);
  });

  it("label failures are reported, not thrown", async () => {
    const a = mk(mockFetch(() => ({ status: 403, body: { message: "no" } })).fn);
    const lines = await a.prepare("startup");
    assert.match(lines[0], /^o\/r: label check failed/);
    assert.equal(lines.length, 2);
  });
});
