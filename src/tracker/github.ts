// GitHub Issues tracker adapter (tracker.kind = "github"). See README "Adapter profile: github".
//
// State model: GitHub issues are only open/closed, so workflow states are carried by labels with a
// configurable prefix (default `status:`), e.g. `status:Todo`, `status:In Progress`,
// `status:Human Review`. A closed issue always has state `closed_state` (default "Closed"); an open
// issue without a state label has state `open_state` (default "Open").
import { spawn } from "node:child_process";
import { TrackerError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { Issue, ToolContext, ToolResult, ToolSpec, TrackerAdapter } from "../types.ts";
import { isPlainObject, normState, resolveVar, varRef } from "../util.ts";

export const GITHUB_DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
export const GITHUB_DEFAULT_TERMINAL_STATES = ["Closed", "Done"];
const DEFAULT_SECRET_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export interface GitHubProviderConfig {
  owner: string;
  repo: string;
  token: string;
  token_env: string | null;
  api_url: string;
  state_label_prefix: string;
  open_state: string;
  closed_state: string;
  assignee: string | null;
  blocking_labels: string[];
  priority_label_prefix: string;
  identifier_prefix: string;
  closed_lookback_days: number;
  page_size: number;
  max_pages: number;
  request_timeout_ms: number;
  allow_force_push: boolean;
  protected_branches: string[];
  allowed_states: string[] | null;
}

function cfgErr(msg: string): TrackerError {
  return new TrackerError("invalid_tracker_config", msg);
}

function optStr(p: Record<string, unknown>, k: string): string | null {
  const v = p[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw cfgErr(`tracker.provider.${k} must be a string`);
  return v;
}

function optInt(p: Record<string, unknown>, k: string, def: number, min = 1): number {
  const v = p[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw cfgErr(`tracker.provider.${k} must be an integer >= ${min}`);
  return v;
}

function optList(p: Record<string, unknown>, k: string): string[] | null {
  const v = p[k];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw cfgErr(`tracker.provider.${k} must be a list of strings`);
  return v as string[];
}

/** Parse + validate `tracker.provider` for kind=github. Throws TrackerError. */
export function parseGitHubProvider(p: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): GitHubProviderConfig {
  let owner = optStr(p, "owner");
  let repo = optStr(p, "repo");
  const repository = optStr(p, "repository");
  if (repository) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
    if (!m) throw cfgErr("tracker.provider.repository must look like 'owner/repo'");
    owner ??= m[1];
    repo ??= m[2];
  }
  if (owner) owner = String(resolveVar(owner, env)).trim();
  if (repo) repo = String(resolveVar(repo, env)).trim();
  if (!owner || !repo) throw cfgErr("tracker.provider.owner and tracker.provider.repo (or repository: owner/repo) are required");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw cfgErr("invalid owner/repo name");

  // Secret: `token` ($VAR supported). If omitted, fall back to GITHUB_TOKEN then GH_TOKEN.
  const rawToken = p.token;
  let token = "";
  let tokenEnv: string | null = null;
  if (rawToken === undefined || rawToken === null) {
    for (const n of ["GITHUB_TOKEN", "GH_TOKEN"]) {
      if (env[n]) {
        token = env[n] as string;
        tokenEnv = n;
        break;
      }
    }
  } else {
    if (typeof rawToken !== "string") throw cfgErr("tracker.provider.token must be a string");
    tokenEnv = varRef(rawToken);
    token = String(resolveVar(rawToken, env));
  }
  if (!token) {
    throw new TrackerError(
      "missing_tracker_secret",
      `GitHub token is missing (set tracker.provider.token: $GITHUB_TOKEN${tokenEnv ? `; $${tokenEnv} is empty` : ""})`,
    );
  }

  const apiUrl = (optStr(p, "api_url") ?? "https://api.github.com").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiUrl)) throw cfgErr("tracker.provider.api_url must be an http(s) URL");
  const prefix = optStr(p, "state_label_prefix") ?? "status:";
  if (!prefix) throw cfgErr("tracker.provider.state_label_prefix must be non-empty");

  return {
    owner,
    repo,
    token,
    token_env: tokenEnv,
    api_url: apiUrl,
    state_label_prefix: prefix,
    open_state: optStr(p, "open_state") ?? "Open",
    closed_state: optStr(p, "closed_state") ?? "Closed",
    assignee: optStr(p, "assignee"),
    blocking_labels: (optList(p, "blocking_labels") ?? []).map(normState).filter(Boolean),
    priority_label_prefix: optStr(p, "priority_label_prefix") ?? "priority:",
    identifier_prefix: optStr(p, "identifier_prefix") ?? repo,
    closed_lookback_days: optInt(p, "closed_lookback_days", 14),
    page_size: Math.min(optInt(p, "page_size", 100), 100),
    max_pages: optInt(p, "max_pages", 50),
    request_timeout_ms: optInt(p, "request_timeout_ms", 30000),
    allow_force_push: p.allow_force_push === true,
    protected_branches: optList(p, "protected_branches") ?? ["main", "master"],
    allowed_states: optList(p, "allowed_states"),
  };
}

interface GhResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

type FetchFn = typeof fetch;

export class GitHubAdapter implements TrackerAdapter {
  readonly kind = "github";
  readonly cfg: GitHubProviderConfig;
  private readonly log: Logger;
  private readonly fetchFn: FetchFn;
  private readonly activeStates: string[];
  private readonly terminalStates: string[];
  private repoInfo: { clone_url: string; default_branch: string } | null = null;

  constructor(opts: {
    provider: GitHubProviderConfig;
    activeStates: string[];
    terminalStates: string[];
    log: Logger;
    fetchFn?: FetchFn;
  }) {
    this.cfg = opts.provider;
    this.log = opts.log.child({ tracker: "github", repo: `${opts.provider.owner}/${opts.provider.repo}` });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.activeStates = opts.activeStates;
    this.terminalStates = opts.terminalStates;
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  private repoPath(suffix = ""): string {
    return `/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}${suffix}`;
  }

  async request(method: string, pathOrUrl: string, body?: unknown, okStatuses: number[] = []): Promise<GhResponse> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.cfg.api_url}${pathOrUrl}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.cfg.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "claude-symphony",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.request_timeout_ms),
        redirect: "follow",
      });
    } catch (err) {
      throw new TrackerError("tracker_request", `GitHub request ${method} ${url} failed: ${(err as Error).message}`, {
        retryable: true,
      });
    }
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (res.ok) throw new TrackerError("tracker_response", `GitHub returned non-JSON body for ${method} ${url}`);
        parsed = text;
      }
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, headers: res.headers, body: parsed };

    const msg = isPlainObject(parsed) && typeof parsed.message === "string" ? parsed.message : `HTTP ${res.status}`;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    if (res.status === 429 || ((res.status === 403 || res.status === 429) && (remaining === "0" || retryAfter))) {
      let retryAfterMs: number | null = null;
      if (retryAfter && /^\d+$/.test(retryAfter)) retryAfterMs = Number(retryAfter) * 1000;
      else {
        const reset = res.headers.get("x-ratelimit-reset");
        if (reset && /^\d+$/.test(reset)) retryAfterMs = Math.max(0, Number(reset) * 1000 - Date.now());
      }
      throw new TrackerError("tracker_rate_limited", `GitHub rate limited: ${msg}`, {
        retryable: true,
        retryAfterMs,
        status: res.status,
      });
    }
    throw new TrackerError("tracker_status", `GitHub ${method} ${url} -> ${res.status}: ${msg}`, {
      status: res.status,
      retryable: res.status >= 500,
    });
  }

  /** Follow `Link: rel=next` pagination; preserves order; enforces max_pages. */
  private async paginate(firstPath: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let next: string | null = firstPath;
    let pages = 0;
    while (next) {
      if (pages >= this.cfg.max_pages) {
        throw new TrackerError(
          "tracker_pagination",
          `GitHub pagination exceeded max_pages=${this.cfg.max_pages} for ${firstPath}`,
        );
      }
      const res = await this.request("GET", next);
      pages++;
      if (!Array.isArray(res.body)) throw new TrackerError("tracker_response", `expected JSON array from ${next}`);
      out.push(...res.body);
      next = parseNextLink(res.headers.get("link"));
      if (next && !next.startsWith(this.cfg.api_url)) {
        throw new TrackerError("tracker_pagination", `unexpected pagination link origin: ${next}`);
      }
    }
    return out;
  }

  // ---- Normalization ----------------------------------------------------------------------------

  private stateLabelName(state: string): string {
    return `${this.cfg.state_label_prefix}${state}`;
  }

  /** Returns [normalizedIssue] or null when malformed / out of scope (PRs). */
  normalize(raw: unknown): { issue: Issue | null; reason?: string } {
    if (!isPlainObject(raw)) return { issue: null, reason: "not an object" };
    if (raw.pull_request) return { issue: null, reason: "pull request" };
    const number = raw.number;
    const title = raw.title;
    const ghState = raw.state;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return { issue: null, reason: "missing number" };
    if (typeof title !== "string" || title.trim() === "") return { issue: null, reason: "missing title" };
    if (ghState !== "open" && ghState !== "closed") return { issue: null, reason: "missing state" };

    const rawLabels: string[] = [];
    if (Array.isArray(raw.labels)) {
      for (const l of raw.labels) {
        if (typeof l === "string") rawLabels.push(l);
        else if (isPlainObject(l) && typeof l.name === "string") rawLabels.push(l.name);
      }
    }
    const prefixN = normState(this.cfg.state_label_prefix);
    const stateLabels: string[] = [];
    const labels = new Set<string>();
    let priority: number | null = null;
    const prioPrefix = normState(this.cfg.priority_label_prefix);
    for (const l of rawLabels) {
      const t = l.trim();
      if (!t) continue;
      const n = t.toLowerCase();
      labels.add(n);
      if (n.startsWith(prefixN) && t.length > this.cfg.state_label_prefix.length) {
        const s = t.slice(this.cfg.state_label_prefix.length).trim();
        if (s) stateLabels.push(s);
      }
      if (prioPrefix && n.startsWith(prioPrefix)) {
        const v = n.slice(prioPrefix.length).trim().replace(/^p/, "");
        if (/^\d+$/.test(v) && priority === null) priority = Number(v);
      }
    }

    let state: string;
    let ambiguous = false;
    if (ghState === "closed") state = this.cfg.closed_state;
    else if (stateLabels.length === 0) state = this.cfg.open_state;
    else {
      const uniq = [...new Map(stateLabels.map((s) => [normState(s), s])).values()];
      state = uniq.sort((a, b) => a.localeCompare(b))[0];
      ambiguous = uniq.length > 1;
    }

    const assignees: string[] = [];
    if (Array.isArray(raw.assignees)) {
      for (const a of raw.assignees) if (isPlainObject(a) && typeof a.login === "string") assignees.push(a.login);
    }
    if (assignees.length === 0 && isPlainObject(raw.assignee) && typeof raw.assignee.login === "string") {
      assignees.push(raw.assignee.login);
    }

    let dispatchable = !ambiguous;
    if (this.cfg.assignee) {
      const want = this.cfg.assignee.toLowerCase();
      dispatchable &&= assignees.some((a) => a.toLowerCase() === want);
    }
    if (this.cfg.blocking_labels.some((b) => labels.has(b))) dispatchable = false;

    const ts = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const d = Date.parse(v);
      return Number.isNaN(d) ? null : new Date(d).toISOString();
    };

    const issue: Issue = {
      id: String(number),
      native_ref: {
        provider: "github",
        owner: this.cfg.owner,
        repo: this.cfg.repo,
        number,
        node_id: typeof raw.node_id === "string" ? raw.node_id : null,
        database_id: typeof raw.id === "number" ? raw.id : null,
        assignees,
        state_labels: stateLabels,
      },
      identifier: `${this.cfg.identifier_prefix}-${number}`,
      title,
      description: typeof raw.body === "string" ? raw.body : null,
      priority,
      state,
      branch_name: null,
      url: typeof raw.html_url === "string" ? raw.html_url : null,
      assignee_id: assignees[0] ?? null,
      labels: [...labels],
      blocked_by: [],
      dispatchable,
      created_at: ts(raw.created_at),
      updated_at: ts(raw.updated_at),
    };
    return { issue };
  }

  // ---- Required operations ----------------------------------------------------------------------

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const wanted = new Map<string, string>();
    for (const s of stateNames) if (normState(s)) wanted.set(normState(s), s.trim());
    const closedN = normState(this.cfg.closed_state);
    const openN = normState(this.cfg.open_state);
    const pp = `per_page=${this.cfg.page_size}`;

    const queries: string[] = [];
    let needAllOpen = false;
    for (const [n, spelled] of wanted) {
      if (n === closedN) {
        const since = new Date(Date.now() - this.cfg.closed_lookback_days * 86400_000).toISOString();
        queries.push(this.repoPath(`/issues?state=closed&since=${encodeURIComponent(since)}&sort=updated&direction=desc&${pp}`));
      } else if (n === openN) {
        needAllOpen = true;
      } else if (!spelled.includes(",")) {
        // Label filters are AND-ed and case-insensitive on GitHub, one query per state label.
        queries.push(
          this.repoPath(`/issues?state=open&labels=${encodeURIComponent(this.stateLabelName(spelled))}&sort=created&direction=asc&${pp}`),
        );
      } else {
        needAllOpen = true;
      }
    }
    if (needAllOpen) queries.unshift(this.repoPath(`/issues?state=open&sort=created&direction=asc&${pp}`));

    const seen = new Set<string>();
    const out: Issue[] = [];
    for (const q of queries) {
      const raws = await this.paginate(q);
      for (const raw of raws) {
        const { issue, reason } = this.normalize(raw);
        if (!issue) {
          if (reason !== "pull request") {
            this.log.warn("omitting malformed GitHub issue record", {
              reason,
              number: isPlainObject(raw) ? raw.number : undefined,
            });
          }
          continue;
        }
        if (seen.has(issue.id) || !wanted.has(normState(issue.state))) continue;
        seen.add(issue.id);
        out.push(issue);
      }
    }
    return out;
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    const ids = [...new Set(issueIds)];
    if (ids.length === 0) return [];
    const out: Issue[] = [];
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()!;
        if (!/^[1-9]\d*$/.test(id)) continue; // not a dispatch id in this scope => not visible
        const res = await this.request("GET", this.repoPath(`/issues/${id}`), undefined, [404, 410]);
        if (res.status === 404 || res.status === 410) continue;
        const raw = res.body;
        // Transferred issues redirect to another repository: no longer in scope.
        if (isPlainObject(raw) && typeof raw.repository_url === "string") {
          const expected = `${this.cfg.api_url}${this.repoPath()}`.toLowerCase();
          if (raw.repository_url.toLowerCase() !== expected) continue;
        }
        if (isPlainObject(raw) && raw.pull_request) continue;
        const { issue, reason } = this.normalize(raw);
        if (!issue) throw new TrackerError("tracker_response", `malformed GitHub issue #${id}: ${reason}`);
        if (issue.id !== id) continue;
        out.push(issue);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
    return out;
  }

  secretEnvironmentNames(): string[] {
    const names = new Set(DEFAULT_SECRET_ENV);
    if (this.cfg.token_env) names.add(this.cfg.token_env);
    return [...names];
  }

  // ---- Provider-native agent tools --------------------------------------------------------------

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "github_issue_read",
        description:
          "Read the current GitHub issue (title, body, labels, state, assignees) and, optionally, its comments. Scoped to the issue this session is working on.",
        mutates: false,
        inputSchema: {
          type: "object",
          properties: { include_comments: { type: "boolean", description: "Include comments (default true)" } },
          additionalProperties: false,
        },
      },
      {
        name: "github_issue_comment",
        description: "Post a Markdown comment on the current GitHub issue.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: { body: { type: "string", minLength: 1 } },
          required: ["body"],
          additionalProperties: false,
        },
      },
      {
        name: "github_issue_set_state",
        description: `Move the current issue to a workflow state. States are stored as '${this.cfg.state_label_prefix}<State>' labels; '${this.cfg.closed_state}' closes the issue and '${this.cfg.open_state}' removes all state labels.`,
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", minLength: 1, description: "Target workflow state, e.g. 'Human Review'" },
            close_reason: { type: "string", enum: ["completed", "not_planned"], description: "Only when closing" },
          },
          required: ["state"],
          additionalProperties: false,
        },
      },
      {
        name: "github_issue_labels",
        description: "Add and/or remove non-state labels on the current issue. Use github_issue_set_state for state labels.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            add: { type: "array", items: { type: "string" } },
            remove: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      {
        name: "github_git_push",
        description:
          "Push the workspace's current HEAD to a branch of the configured repository using Symphony's host-side GitHub credential. Protected/default branches are refused.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            branch: { type: "string", description: "Destination branch name, e.g. 'symphony/repo-42'" },
            force: { type: "boolean", description: "Force push (only if allowed by the operator)" },
          },
          required: ["branch"],
          additionalProperties: false,
        },
      },
      {
        name: "github_pr_create",
        description:
          "Open a pull request in the configured repository from `head` (a branch pushed with github_git_push). By default appends 'Closes #<issue>' to the body.",
        mutates: true,
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1 },
            head: { type: "string", minLength: 1 },
            base: { type: "string", description: "Defaults to the repository default branch" },
            body: { type: "string" },
            draft: { type: "boolean" },
            closes_issue: { type: "boolean", description: "Append 'Closes #<issue>' (default true)" },
          },
          required: ["title", "head"],
          additionalProperties: false,
        },
      },
      {
        name: "github_pr_list",
        description: "List pull requests in the configured repository, optionally filtered by head branch.",
        mutates: false,
        inputSchema: {
          type: "object",
          properties: {
            head: { type: "string", description: "Branch name in this repository" },
            state: { type: "string", enum: ["open", "closed", "all"] },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  async executeAgentTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = isPlainObject(args) ? args : {};
    const fail = (code: string, message: string): ToolResult => ({ ok: false, error: { code, message } });
    const ref = ctx.issue.native_ref;
    const number = isPlainObject(ref) && typeof ref.number === "number" ? ref.number : Number(ctx.issue.id);
    if (!Number.isInteger(number) || number <= 0) return fail("invalid_context", "current issue has no GitHub number");
    try {
      switch (name) {
        case "github_issue_read": {
          const res = await this.request("GET", this.repoPath(`/issues/${number}`));
          const { issue } = this.normalize(res.body);
          let comments: unknown[] = [];
          if (a.include_comments !== false) {
            const raw = await this.paginate(this.repoPath(`/issues/${number}/comments?per_page=100`));
            comments = raw.map((c) =>
              isPlainObject(c)
                ? {
                    id: c.id,
                    author: isPlainObject(c.user) ? c.user.login : null,
                    created_at: c.created_at,
                    body: c.body,
                  }
                : c,
            );
          }
          return { ok: true, output: { issue, comments } };
        }
        case "github_issue_comment": {
          if (typeof a.body !== "string" || !a.body.trim()) return fail("invalid_arguments", "body must be a non-empty string");
          const res = await this.request("POST", this.repoPath(`/issues/${number}/comments`), { body: a.body });
          const b = res.body as Record<string, unknown>;
          return { ok: true, output: { id: b?.id, url: b?.html_url } };
        }
        case "github_issue_set_state":
          return await this.toolSetState(number, a);
        case "github_issue_labels": {
          const add = Array.isArray(a.add) ? a.add.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
          const remove = Array.isArray(a.remove)
            ? a.remove.filter((x): x is string => typeof x === "string" && x.trim() !== "")
            : [];
          const pn = normState(this.cfg.state_label_prefix);
          if ([...add, ...remove].some((l) => normState(l).startsWith(pn))) {
            return fail("invalid_arguments", "state labels must be changed with github_issue_set_state");
          }
          if (add.length) await this.request("POST", this.repoPath(`/issues/${number}/labels`), { labels: add });
          for (const l of remove) {
            await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(l)}`), undefined, [404]);
          }
          return { ok: true, output: { added: add, removed: remove } };
        }
        case "github_git_push":
          return await this.toolPush(a, ctx);
        case "github_pr_create": {
          if (typeof a.title !== "string" || !a.title.trim()) return fail("invalid_arguments", "title is required");
          if (typeof a.head !== "string" || !validBranch(a.head)) return fail("invalid_arguments", "head must be a valid branch name");
          const info = await this.getRepoInfo();
          const base = typeof a.base === "string" && a.base ? a.base : info.default_branch;
          let body = typeof a.body === "string" ? a.body : "";
          if (a.closes_issue !== false && !new RegExp(`#${number}\\b`).test(body)) {
            body = `${body}${body ? "\n\n" : ""}Closes #${number}`;
          }
          const res = await this.request("POST", this.repoPath(`/pulls`), {
            title: a.title,
            head: a.head,
            base,
            body,
            draft: a.draft === true,
          });
          const b = res.body as Record<string, unknown>;
          return { ok: true, output: { number: b?.number, url: b?.html_url, base, head: a.head } };
        }
        case "github_pr_list": {
          const params = new URLSearchParams({ state: typeof a.state === "string" ? a.state : "open", per_page: "50" });
          if (typeof a.head === "string" && a.head) params.set("head", `${this.cfg.owner}:${a.head}`);
          const res = await this.request("GET", this.repoPath(`/pulls?${params}`));
          const list = Array.isArray(res.body) ? res.body : [];
          return {
            ok: true,
            output: list.map((p) =>
              isPlainObject(p)
                ? {
                    number: p.number,
                    title: p.title,
                    state: p.state,
                    draft: p.draft,
                    url: p.html_url,
                    head: isPlainObject(p.head) ? p.head.ref : null,
                    base: isPlainObject(p.base) ? p.base.ref : null,
                  }
                : p,
            ),
          };
        }
        default:
          return fail("unsupported_tool", `unsupported tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof TrackerError) return fail(err.category, err.message);
      return fail("tool_error", (err as Error).message);
    }
  }

  private async toolSetState(number: number, a: Record<string, unknown>): Promise<ToolResult> {
    if (typeof a.state !== "string" || !a.state.trim()) {
      return { ok: false, error: { code: "invalid_arguments", message: "state must be a non-empty string" } };
    }
    const target = a.state.trim();
    if (target.includes(",")) return { ok: false, error: { code: "invalid_arguments", message: "state must not contain ','" } };
    const tn = normState(target);
    if (this.cfg.allowed_states) {
      const allowed = new Set(
        [...this.cfg.allowed_states, ...this.activeStates, ...this.terminalStates, this.cfg.open_state, this.cfg.closed_state].map(
          normState,
        ),
      );
      if (!allowed.has(tn)) {
        return { ok: false, error: { code: "invalid_arguments", message: `state '${target}' is not an allowed workflow state` } };
      }
    }
    const res = await this.request("GET", this.repoPath(`/issues/${number}`));
    const raw = res.body as Record<string, unknown>;
    const pn = normState(this.cfg.state_label_prefix);
    const current: string[] = Array.isArray(raw.labels)
      ? raw.labels.map((l) => (typeof l === "string" ? l : isPlainObject(l) ? String(l.name ?? "") : "")).filter(Boolean)
      : [];
    const stateLabels = current.filter((l) => normState(l).startsWith(pn));
    const desired = tn === normState(this.cfg.closed_state) || tn === normState(this.cfg.open_state) ? null : this.stateLabelName(target);

    for (const l of stateLabels) {
      if (desired && normState(l) === normState(desired)) continue;
      await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(l)}`), undefined, [404]);
    }
    if (desired && !stateLabels.some((l) => normState(l) === normState(desired))) {
      await this.request("POST", this.repoPath(`/issues/${number}/labels`), { labels: [desired] });
    }
    if (tn === normState(this.cfg.closed_state)) {
      if (raw.state !== "closed") {
        await this.request("PATCH", this.repoPath(`/issues/${number}`), {
          state: "closed",
          state_reason: a.close_reason === "not_planned" ? "not_planned" : "completed",
        });
      }
    } else if (raw.state === "closed") {
      await this.request("PATCH", this.repoPath(`/issues/${number}`), { state: "open" });
    }
    return { ok: true, output: { state: target, label: desired } };
  }

  private async getRepoInfo(): Promise<{ clone_url: string; default_branch: string }> {
    if (this.repoInfo) return this.repoInfo;
    const res = await this.request("GET", this.repoPath());
    const b = res.body;
    if (!isPlainObject(b) || typeof b.clone_url !== "string" || typeof b.default_branch !== "string") {
      throw new TrackerError("tracker_response", "unexpected repository payload");
    }
    this.repoInfo = { clone_url: b.clone_url, default_branch: b.default_branch };
    return this.repoInfo;
  }

  private async toolPush(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const branch = typeof a.branch === "string" ? a.branch.trim() : "";
    if (!validBranch(branch)) return { ok: false, error: { code: "invalid_arguments", message: "invalid branch name" } };
    const info = await this.getRepoInfo();
    const protectedSet = new Set([info.default_branch, ...this.cfg.protected_branches].map((b) => b.toLowerCase()));
    if (protectedSet.has(branch.toLowerCase())) {
      return { ok: false, error: { code: "forbidden", message: `refusing to push to protected branch '${branch}'` } };
    }
    const force = a.force === true;
    if (force && !this.cfg.allow_force_push) {
      return { ok: false, error: { code: "forbidden", message: "force push is disabled by tracker.provider.allow_force_push" } };
    }
    const basic = Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64");
    const refspec = `${force ? "+" : ""}HEAD:refs/heads/${branch}`;
    // Credentials go through GIT_CONFIG_* env of the host-side git process only (never the agent),
    // and repository hooks are disabled so workspace content cannot observe them.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: `http.${new URL(info.clone_url).origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "",
    };
    const res = await runGit(["-C", ctx.workspacePath, "push", "--porcelain", info.clone_url, refspec], env, 120_000);
    const output = res.output.replaceAll(this.cfg.token, "***").replaceAll(basic, "***");
    if (res.code !== 0) return { ok: false, error: { code: "git_push_failed", message: output.slice(-4000) } };
    return { ok: true, output: { branch, remote: info.clone_url, forced: force, output: output.slice(-2000) } };
  }
}

export function validBranch(b: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(b) &&
    !b.includes("..") &&
    !b.startsWith("/") &&
    !b.endsWith("/") &&
    !b.endsWith(".lock") &&
    !b.startsWith("-") &&
    !b.includes("//")
  );
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

function runGit(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => (output += b.toString()));
    child.stderr.on("data", (b: Buffer) => (output += b.toString()));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ code: -1, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, output });
    });
  });
}
