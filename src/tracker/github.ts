// GitHub Issues tracker adapter (tracker.kind = "github"). See README "Adapter profile: github".
//
// State model: GitHub issues are only open/closed, so workflow states are carried by labels with a
// configurable prefix (default `status:`), e.g. `status:Todo`, `status:In Progress`,
// `status:Human Review`. A closed issue always has state `closed_state` (default "Closed"); an open
// issue without a state label has state `open_state` (default "Open").
import { spawn } from "node:child_process";
import path from "node:path";
import { TrackerError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { Issue, ToolContext, ToolImage, ToolResult, ToolSpec, TrackerAdapter } from "../types.ts";
import { isPlainObject, normState, resolveVar, varRef } from "../util.ts";
import {
  ATTACHMENTS_REL_DIR,
  AttachmentError,
  countMarkdownImages,
  downloadImage,
  ensureAttachmentsDir,
  extractImageRefs,
  INLINE_MAX_BYTES,
  stripQuery,
  writeFileNoFollow,
} from "./github-attachments.ts";

export const GITHUB_DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
export const GITHUB_DEFAULT_TERMINAL_STATES = ["Closed", "Done"];
const DEFAULT_SECRET_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** One repository served by the adapter. */
export interface GitHubRepoTarget {
  owner: string;
  repo: string;
  /** `owner/repo` as configured. */
  full_name: string;
  /** Prefix for human identifiers (`<prefix>-<number>`); unique across repos. */
  identifier_prefix: string;
  protected_branches: string[];
}

export interface GitHubProviderConfig {
  repos: GitHubRepoTarget[];
  token: string;
  token_env: string | null;
  api_url: string;
  web_url: string;
  state_label_prefix: string;
  open_state: string;
  closed_state: string;
  assignee: string | null;
  blocking_labels: string[];
  priority_label_prefix: string;
  closed_lookback_days: number;
  page_size: number;
  max_pages: number;
  request_timeout_ms: number;
  allow_force_push: boolean;
  allowed_states: string[] | null;
  /** Limits for `github_issue_attachments`. */
  attachment_max_bytes: number;
  attachment_max_count: number;
  /** Create missing workflow labels in every repository at startup. */
  ensure_labels: boolean;
}

function cfgErr(msg: string): TrackerError {
  return new TrackerError("invalid_tracker_config", msg);
}

function optStr(p: Record<string, unknown>, k: string, where = "tracker.provider"): string | null {
  const v = p[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw cfgErr(`${where}.${k} must be a string`);
  return v;
}

function optInt(p: Record<string, unknown>, k: string, def: number, min = 1): number {
  const v = p[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw cfgErr(`tracker.provider.${k} must be an integer >= ${min}`);
  return v;
}

function optList(p: Record<string, unknown>, k: string, where = "tracker.provider"): string[] | null {
  const v = p[k];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw cfgErr(`${where}.${k} must be a list of strings`);
  return v as string[];
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Resolve `owner/repo`, or a bare `repo` with `defaultOwner`. */
function splitRepo(spec: string, defaultOwner: string | null, where: string, env: NodeJS.ProcessEnv): [string, string] {
  const t = String(resolveVar(spec, env)).trim();
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(t);
  const [owner, repo] = m ? [m[1], m[2]] : [defaultOwner, t];
  if (!owner || !repo) throw cfgErr(`${where} must look like 'owner/repo' (or set tracker.provider.owner)`);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw cfgErr(`${where}: invalid owner/repo name '${t}'`);
  return [owner, repo];
}

/** Parse + validate `tracker.provider` for kind=github. Throws TrackerError. */
export function parseGitHubProvider(p: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): GitHubProviderConfig {
  const topOwnerRaw = optStr(p, "owner");
  const topOwner = topOwnerRaw ? String(resolveVar(topOwnerRaw, env)).trim() || null : null;
  const defaultProtected = optList(p, "protected_branches") ?? ["main", "master"];
  const topPrefix = optStr(p, "identifier_prefix");

  const repos: GitHubRepoTarget[] = [];
  const add = (owner: string, repo: string, prefix: string | null, prot: string[] | null) =>
    repos.push({
      owner,
      repo,
      full_name: `${owner}/${repo}`,
      identifier_prefix: (prefix ?? repo).trim(),
      protected_branches: prot ?? defaultProtected,
    });

  const list = p.repositories;
  if (list !== undefined && list !== null) {
    if (p.repository !== undefined || p.repo !== undefined) {
      throw cfgErr("use either tracker.provider.repositories or repository/repo, not both");
    }
    if (topPrefix !== null) {
      throw cfgErr("tracker.provider.identifier_prefix is single-repo only; set identifier_prefix per entry in repositories");
    }
    if (!Array.isArray(list) || list.length === 0) throw cfgErr("tracker.provider.repositories must be a non-empty list");
    list.forEach((entry, i) => {
      const where = `tracker.provider.repositories[${i}]`;
      if (typeof entry === "string") {
        const [o, r] = splitRepo(entry, topOwner, where, env);
        add(o, r, null, null);
      } else if (isPlainObject(entry)) {
        const spec = optStr(entry, "repository", where) ?? optStr(entry, "repo", where);
        if (!spec) throw cfgErr(`${where}.repository is required`);
        const owner = optStr(entry, "owner", where);
        const [o, r] = splitRepo(spec, owner ? String(resolveVar(owner, env)).trim() : topOwner, where, env);
        add(o, r, optStr(entry, "identifier_prefix", where), optList(entry, "protected_branches", where));
      } else {
        throw cfgErr(`${where} must be 'owner/repo' or a map with repository:`);
      }
    });
  } else {
    let owner = topOwner;
    let repo = optStr(p, "repo");
    const repository = optStr(p, "repository");
    if (repository) {
      const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
      if (!m) throw cfgErr("tracker.provider.repository must look like 'owner/repo'");
      owner ??= m[1];
      repo ??= m[2];
    }
    if (repo) repo = String(resolveVar(repo, env)).trim();
    if (!owner || !repo) {
      throw cfgErr("tracker.provider.repositories, repository: owner/repo, or owner + repo is required");
    }
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw cfgErr("invalid owner/repo name");
    add(owner, repo, topPrefix, null);
  }

  const seenRepo = new Set<string>();
  const seenPrefix = new Map<string, string>();
  for (const r of repos) {
    const k = r.full_name.toLowerCase();
    if (seenRepo.has(k)) throw cfgErr(`repository ${r.full_name} is listed more than once`);
    seenRepo.add(k);
    if (!r.identifier_prefix) throw cfgErr(`identifier_prefix for ${r.full_name} must be non-empty`);
    const pk = r.identifier_prefix.toLowerCase();
    const other = seenPrefix.get(pk);
    if (other) {
      throw cfgErr(
        `identifier prefix '${r.identifier_prefix}' is used by both ${other} and ${r.full_name}; set identifier_prefix on one of them`,
      );
    }
    seenPrefix.set(pk, r.full_name);
  }

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
  const webUrl = (optStr(p, "web_url") ?? defaultWebUrl(apiUrl)).replace(/\/+$/, "");
  const prefix = optStr(p, "state_label_prefix") ?? "status:";
  if (!prefix) throw cfgErr("tracker.provider.state_label_prefix must be non-empty");

  return {
    repos,
    token,
    token_env: tokenEnv,
    api_url: apiUrl,
    web_url: webUrl,
    state_label_prefix: prefix,
    open_state: optStr(p, "open_state") ?? "Open",
    closed_state: optStr(p, "closed_state") ?? "Closed",
    assignee: optStr(p, "assignee"),
    blocking_labels: (optList(p, "blocking_labels") ?? []).map(normState).filter(Boolean),
    priority_label_prefix: optStr(p, "priority_label_prefix") ?? "priority:",
    closed_lookback_days: optInt(p, "closed_lookback_days", 14),
    page_size: Math.min(optInt(p, "page_size", 100), 100),
    max_pages: optInt(p, "max_pages", 50),
    request_timeout_ms: optInt(p, "request_timeout_ms", 30000),
    allow_force_push: p.allow_force_push === true,
    allowed_states: optList(p, "allowed_states"),
    attachment_max_bytes: optInt(p, "attachment_max_bytes", 10 * 1024 * 1024),
    attachment_max_count: optInt(p, "attachment_max_count", 20),
    ensure_labels: p.ensure_labels !== false,
  };
}

/** github.com API -> github.com web; GHES `https://host/api/v3` -> `https://host`. */
function defaultWebUrl(apiUrl: string): string {
  if (/^https:\/\/api\.github\.com$/i.test(apiUrl)) return "https://github.com";
  return apiUrl.replace(/\/api\/v3$/i, "");
}

/** Dispatch id of a GitHub issue: `owner/repo#number` (unique across configured repositories). */
export function githubIssueId(t: { owner: string; repo: string }, number: number): string {
  return `${t.owner}/${t.repo}#${number}`;
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
  private readonly requiredLabels: string[];
  private readonly repoInfo = new Map<string, { clone_url: string; default_branch: string }>();

  constructor(opts: {
    provider: GitHubProviderConfig;
    activeStates: string[];
    terminalStates: string[];
    log: Logger;
    fetchFn?: FetchFn;
    requiredLabels?: string[];
  }) {
    this.cfg = opts.provider;
    this.log = opts.log.child({ tracker: "github", repos: opts.provider.repos.map((r) => r.full_name).join(",") });
    this.fetchFn = opts.fetchFn ?? fetch;
    this.activeStates = opts.activeStates;
    this.terminalStates = opts.terminalStates;
    this.requiredLabels = opts.requiredLabels ?? [];
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  private repoPath(t: GitHubRepoTarget, suffix = ""): string {
    return `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}${suffix}`;
  }

  /** Case-insensitive lookup of a configured repository. */
  findRepo(owner: unknown, repo: unknown): GitHubRepoTarget | null {
    if (typeof owner !== "string" || typeof repo !== "string") return null;
    const k = `${owner}/${repo}`.toLowerCase();
    return this.cfg.repos.find((r) => r.full_name.toLowerCase() === k) ?? null;
  }

  private repoFromApiUrl(u: unknown): GitHubRepoTarget | null {
    if (typeof u !== "string") return null;
    const m = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(u);
    return m ? this.findRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2])) : null;
  }

  /** Repository of an already-normalized issue (native_ref first, then the id). */
  repoOfIssue(issue: Issue): GitHubRepoTarget | null {
    const ref = issue.native_ref;
    if (isPlainObject(ref)) {
      const t = this.findRepo(ref.owner, ref.repo);
      if (t) return t;
    }
    const m = ISSUE_ID_RE.exec(issue.id);
    return m ? this.findRepo(m[1], m[2]) : null;
  }

  async request(
    method: string,
    pathOrUrl: string,
    body?: unknown,
    okStatuses: number[] = [],
    accept = "application/vnd.github+json",
  ): Promise<GhResponse> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.cfg.api_url}${pathOrUrl}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Accept: accept,
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
  private async paginate(firstPath: string, accept?: string): Promise<unknown[]> {
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
      const res = await this.request("GET", next, undefined, [], accept);
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
  normalize(raw: unknown, target?: GitHubRepoTarget): { issue: Issue | null; reason?: string } {
    if (!isPlainObject(raw)) return { issue: null, reason: "not an object" };
    const t = target ?? this.repoFromApiUrl(raw.repository_url) ?? this.cfg.repos[0];
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
      id: githubIssueId(t, number),
      native_ref: {
        provider: "github",
        owner: t.owner,
        repo: t.repo,
        full_name: t.full_name,
        clone_url: `${this.cfg.web_url}/${t.owner}/${t.repo}.git`,
        number,
        node_id: typeof raw.node_id === "string" ? raw.node_id : null,
        database_id: typeof raw.id === "number" ? raw.id : null,
        assignees,
        state_labels: stateLabels,
      },
      identifier: `${t.identifier_prefix}-${number}`,
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

    const suffixes: string[] = [];
    let needAllOpen = false;
    for (const [n, spelled] of wanted) {
      if (n === closedN) {
        const since = new Date(Date.now() - this.cfg.closed_lookback_days * 86400_000).toISOString();
        suffixes.push(`/issues?state=closed&since=${encodeURIComponent(since)}&sort=updated&direction=desc&${pp}`);
      } else if (n === openN) {
        needAllOpen = true;
      } else if (!spelled.includes(",")) {
        // Label filters are AND-ed and case-insensitive on GitHub, one query per state label.
        suffixes.push(`/issues?state=open&labels=${encodeURIComponent(this.stateLabelName(spelled))}&sort=created&direction=asc&${pp}`);
      } else {
        needAllOpen = true;
      }
    }
    if (needAllOpen) suffixes.unshift(`/issues?state=open&sort=created&direction=asc&${pp}`);

    // Repositories are queried in configuration order; any failure fails the whole fetch so the
    // orchestrator never dispatches from a partial view.
    const queries: [GitHubRepoTarget, string][] = [];
    for (const t of this.cfg.repos) for (const sfx of suffixes) queries.push([t, this.repoPath(t, sfx)]);

    const seen = new Set<string>();
    const out: Issue[] = [];
    for (const [t, q] of queries) {
      const raws = await this.paginate(q);
      for (const raw of raws) {
        const { issue, reason } = this.normalize(raw, t);
        if (!issue) {
          if (reason !== "pull request") {
            this.log.warn("omitting malformed GitHub issue record", {
              reason,
              repo: t.full_name,
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
        const m = ISSUE_ID_RE.exec(id);
        const t = m ? this.findRepo(m[1], m[2]) : null;
        if (!m || !t) continue; // not a dispatch id of a configured repository => not visible
        const res = await this.request("GET", this.repoPath(t, `/issues/${m[3]}`), undefined, [404, 410]);
        if (res.status === 404 || res.status === 410) continue;
        const raw = res.body;
        // Transferred issues redirect to another repository: no longer in scope.
        if (isPlainObject(raw) && typeof raw.repository_url === "string") {
          const expected = `${this.cfg.api_url}${this.repoPath(t)}`.toLowerCase();
          if (raw.repository_url.toLowerCase() !== expected) continue;
        }
        if (isPlainObject(raw) && raw.pull_request) continue;
        const { issue, reason } = this.normalize(raw, t);
        if (!issue) throw new TrackerError("tracker_response", `malformed GitHub issue ${id}: ${reason}`);
        if (issue.id.toLowerCase() !== id.toLowerCase()) continue;
        out.push(issue);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
    return out;
  }

  // ---- Label setup -------------------------------------------------------------------------------

  /**
   * Labels the workflow relies on: `<prefix><state>` for every active / terminal / allowed state
   * (except the open/closed pseudo-states, which have no label), plus required and blocking labels.
   */
  wantedLabels(): { name: string; color: string; description: string }[] {
    const out = new Map<string, { name: string; color: string; description: string }>();
    const add = (name: string, color: string, description: string) => {
      const n = name.trim();
      if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, color, description });
    };
    const skip = new Set([normState(this.cfg.open_state), normState(this.cfg.closed_state)]);
    const terminal = new Set(this.terminalStates.map(normState));
    for (const st of [...this.activeStates, ...this.terminalStates, ...(this.cfg.allowed_states ?? [])]) {
      if (skip.has(normState(st)) || st.includes(",")) continue;
      const kind = terminal.has(normState(st)) ? "terminal" : this.activeStates.some((a) => normState(a) === normState(st)) ? "active" : "handoff";
      add(this.stateLabelName(st.trim()), kind === "active" ? "1d76db" : kind === "terminal" ? "0e8a16" : "fbca04", `Symphony workflow state (${kind})`);
    }
    for (const l of this.requiredLabels) add(l, "5319e7", "Symphony: issues with this label are eligible for agents");
    for (const l of this.cfg.blocking_labels) add(l, "b60205", "Symphony: agents skip issues with this label");
    return [...out.values()];
  }

  async prepare(mode: "check" | "startup" | "apply"): Promise<string[]> {
    const create = mode === "apply" || (mode === "startup" && this.cfg.ensure_labels);
    const wanted = this.wantedLabels();
    const lines: string[] = [];
    for (const t of this.cfg.repos) {
      try {
        const existing = await this.paginate(this.repoPath(t, `/labels?per_page=100`));
        const have = new Set(existing.map((l) => (isPlainObject(l) && typeof l.name === "string" ? l.name.toLowerCase() : "")));
        const missing = wanted.filter((w) => !have.has(w.name.toLowerCase()));
        if (missing.length === 0) {
          lines.push(`${t.full_name}: all ${wanted.length} workflow labels present`);
          continue;
        }
        if (!create) {
          lines.push(`${t.full_name}: missing labels: ${missing.map((m) => m.name).join(", ")}`);
          continue;
        }
        for (const m of missing) {
          await this.request("POST", this.repoPath(t, "/labels"), m, [422]); // 422 = created concurrently
        }
        lines.push(`${t.full_name}: created labels: ${missing.map((m) => m.name).join(", ")}`);
        this.log.info("created missing GitHub labels", { repo: t.full_name, labels: missing.map((m) => m.name).join(",") });
      } catch (err) {
        lines.push(`${t.full_name}: label check failed: ${(err as Error).message}`);
        this.log.warn("GitHub label setup failed", { repo: t.full_name, error: (err as Error).message });
      }
    }
    return lines;
  }

  /** Extra env for hooks and the agent: lets one after_create hook clone the right repository. */
  issueEnvironment(issue: Issue): Record<string, string> {
    const t = this.repoOfIssue(issue);
    if (!t) return {};
    const ref = issue.native_ref;
    return {
      SYMPHONY_ISSUE_REPO: t.full_name,
      SYMPHONY_ISSUE_REPO_OWNER: t.owner,
      SYMPHONY_ISSUE_REPO_NAME: t.repo,
      SYMPHONY_ISSUE_NUMBER: isPlainObject(ref) && typeof ref.number === "number" ? String(ref.number) : "",
      SYMPHONY_REPO_URL: `${this.cfg.web_url}/${t.owner}/${t.repo}.git`,
    };
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
        name: "github_issue_attachments",
        description:
          "Download the images (screenshots, diagrams) embedded in the current issue's body and comments. " +
          "Symphony fetches them host-side (private repositories work), returns supported images inline so you can see them, " +
          `and saves every image under '${ATTACHMENTS_REL_DIR}/' in the workspace (git-ignored) so you can re-open them later with your file-reading tool.`,
        mutates: false,
        inputSchema: {
          type: "object",
          properties: {
            include_comments: { type: "boolean", description: "Also scan comments (default true)" },
            comment_ids: { type: "array", items: { type: "integer" }, description: "Only these comments (body is skipped unless include_body)" },
            include_body: { type: "boolean", description: "Scan the issue body (default true)" },
            max_images: { type: "integer", minimum: 1, description: "Maximum images to download (default/limit set by the operator)" },
            inline: { type: "boolean", description: "Return images inline in the tool result (default true); false = only save files" },
          },
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
          "Push the workspace's current HEAD to a branch of the current issue's repository using Symphony's host-side GitHub credential. Protected/default branches are refused.",
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
          "Open a pull request in the current issue's repository from `head` (a branch pushed with github_git_push). By default appends 'Closes #<issue>' to the body.",
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
        description: "List pull requests in the current issue's repository, optionally filtered by head branch.",
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
    const t = this.repoOfIssue(ctx.issue);
    if (!t) return fail("invalid_context", "current issue does not belong to a configured repository");
    try {
      switch (name) {
        case "github_issue_read": {
          const res = await this.request("GET", this.repoPath(t, `/issues/${number}`));
          const { issue } = this.normalize(res.body, t);
          let comments: unknown[] = [];
          if (a.include_comments !== false) {
            const raw = await this.paginate(this.repoPath(t, `/issues/${number}/comments?per_page=100`));
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
          const imageRefs =
            countMarkdownImages(issue?.description ?? null) +
            comments.reduce<number>((n, c) => n + (isPlainObject(c) && typeof c.body === "string" ? countMarkdownImages(c.body) : 0), 0);
          return {
            ok: true,
            output: {
              issue,
              comments,
              ...(imageRefs ? { images_referenced: imageRefs, hint: "call github_issue_attachments to view the images" } : {}),
            },
          };
        }
        case "github_issue_attachments":
          return await this.toolAttachments(t, number, a, ctx);
        case "github_issue_comment": {
          if (typeof a.body !== "string" || !a.body.trim()) return fail("invalid_arguments", "body must be a non-empty string");
          const res = await this.request("POST", this.repoPath(t, `/issues/${number}/comments`), { body: a.body });
          const b = res.body as Record<string, unknown>;
          return { ok: true, output: { id: b?.id, url: b?.html_url } };
        }
        case "github_issue_set_state":
          return await this.toolSetState(t, number, a);
        case "github_issue_labels": {
          const add = Array.isArray(a.add) ? a.add.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
          const remove = Array.isArray(a.remove)
            ? a.remove.filter((x): x is string => typeof x === "string" && x.trim() !== "")
            : [];
          const pn = normState(this.cfg.state_label_prefix);
          if ([...add, ...remove].some((l) => normState(l).startsWith(pn))) {
            return fail("invalid_arguments", "state labels must be changed with github_issue_set_state");
          }
          if (add.length) await this.request("POST", this.repoPath(t, `/issues/${number}/labels`), { labels: add });
          for (const l of remove) {
            await this.request("DELETE", this.repoPath(t, `/issues/${number}/labels/${encodeURIComponent(l)}`), undefined, [404]);
          }
          return { ok: true, output: { added: add, removed: remove } };
        }
        case "github_git_push":
          return await this.toolPush(t, a, ctx);
        case "github_pr_create": {
          if (typeof a.title !== "string" || !a.title.trim()) return fail("invalid_arguments", "title is required");
          if (typeof a.head !== "string" || !validBranch(a.head)) return fail("invalid_arguments", "head must be a valid branch name");
          const info = await this.getRepoInfo(t);
          const base = typeof a.base === "string" && a.base ? a.base : info.default_branch;
          let body = typeof a.body === "string" ? a.body : "";
          if (a.closes_issue !== false && !new RegExp(`#${number}\\b`).test(body)) {
            body = `${body}${body ? "\n\n" : ""}Closes #${number}`;
          }
          const res = await this.request("POST", this.repoPath(t, `/pulls`), {
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
          if (typeof a.head === "string" && a.head) params.set("head", `${t.owner}:${a.head}`);
          const res = await this.request("GET", this.repoPath(t, `/pulls?${params}`));
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

  private async toolAttachments(
    t: GitHubRepoTarget,
    number: number,
    a: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const FULL = "application/vnd.github.full+json"; // body + body_html (signed URLs for private repos)
    const onlyComments = Array.isArray(a.comment_ids) ? new Set(a.comment_ids.filter((x) => typeof x === "number")) : null;
    const includeBody = a.include_body === undefined ? !onlyComments : a.include_body !== false;
    const includeComments = onlyComments ? true : a.include_comments !== false;
    const max = Math.min(
      typeof a.max_images === "number" && Number.isInteger(a.max_images) && a.max_images > 0 ? a.max_images : this.cfg.attachment_max_count,
      this.cfg.attachment_max_count,
    );
    const inline = a.inline !== false;

    type Source = { source: string; comment_id: number | null; author: string | null; md: string | null; html: string | null };
    const sources: Source[] = [];
    if (includeBody) {
      const res = await this.request("GET", this.repoPath(t, `/issues/${number}`), undefined, [], FULL);
      const b = isPlainObject(res.body) ? res.body : {};
      sources.push({
        source: "issue",
        comment_id: null,
        author: isPlainObject(b.user) && typeof b.user.login === "string" ? b.user.login : null,
        md: typeof b.body === "string" ? b.body : null,
        html: typeof b.body_html === "string" ? b.body_html : null,
      });
    }
    if (includeComments) {
      const raw = await this.paginate(this.repoPath(t, `/issues/${number}/comments?per_page=100`), FULL);
      for (const c of raw) {
        if (!isPlainObject(c) || typeof c.id !== "number") continue;
        if (onlyComments && !onlyComments.has(c.id)) continue;
        sources.push({
          source: `comment-${c.id}`,
          comment_id: c.id,
          author: isPlainObject(c.user) && typeof c.user.login === "string" ? c.user.login : null,
          md: typeof c.body === "string" ? c.body : null,
          html: typeof c.body_html === "string" ? c.body_html : null,
        });
      }
    }

    const refs = sources.flatMap((s) => extractImageRefs(s.md, s.html).map((r, i) => ({ ...r, s, index: i + 1 })));
    if (refs.length === 0) return { ok: true, output: { images: [], total_found: 0, message: "no images referenced" } };

    let dir: string;
    try {
      dir = ensureAttachmentsDir(ctx.workspacePath);
    } catch (err) {
      return { ok: false, error: { code: "unsafe_path", message: (err as Error).message } };
    }
    const results: Record<string, unknown>[] = [];
    const images: ToolImage[] = [];
    let inlineBytes = 0;
    for (const r of refs.slice(0, max)) {
      const base = { source: r.s.source, comment_id: r.s.comment_id, author: r.s.author, alt: r.alt, url: stripQuery(r.url) };
      try {
        const got = await downloadImage(this.fetchFn, r.url, {
          webUrl: this.cfg.web_url,
          token: this.cfg.token,
          maxBytes: this.cfg.attachment_max_bytes,
          timeoutMs: this.cfg.request_timeout_ms,
        });
        const name = `${r.s.source}-${r.index}.${got.kind.ext}`;
        writeFileNoFollow(path.join(dir, name), got.data);
        // Keep the total inline payload bounded (several MB of base64 per response at most).
        const canInline = inline && got.kind.inlinable && got.data.length <= INLINE_MAX_BYTES && inlineBytes + got.data.length <= 15_000_000;
        if (canInline) {
          inlineBytes += got.data.length;
          images.push({ mimeType: got.kind.mime, data: got.data.toString("base64") });
        }
        results.push({ ...base, path: path.join(ATTACHMENTS_REL_DIR, name), mime: got.kind.mime, bytes: got.data.length, inline_index: canInline ? images.length : null });
      } catch (err) {
        const code = err instanceof AttachmentError ? err.code : "download_failed";
        results.push({ ...base, error: { code, message: (err as Error).message } });
      }
    }
    return {
      ok: true,
      output: {
        images: results,
        total_found: refs.length,
        downloaded: results.filter((x) => !x.error).length,
        truncated: refs.length > max,
        note: "inline_index = position of the image among the images attached to this result (1-based); path is relative to the workspace",
      },
      images,
    };
  }

  private async toolSetState(t: GitHubRepoTarget, number: number, a: Record<string, unknown>): Promise<ToolResult> {
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
    const res = await this.request("GET", this.repoPath(t, `/issues/${number}`));
    const raw = res.body as Record<string, unknown>;
    const pn = normState(this.cfg.state_label_prefix);
    const current: string[] = Array.isArray(raw.labels)
      ? raw.labels.map((l) => (typeof l === "string" ? l : isPlainObject(l) ? String(l.name ?? "") : "")).filter(Boolean)
      : [];
    const stateLabels = current.filter((l) => normState(l).startsWith(pn));
    const desired = tn === normState(this.cfg.closed_state) || tn === normState(this.cfg.open_state) ? null : this.stateLabelName(target);

    for (const l of stateLabels) {
      if (desired && normState(l) === normState(desired)) continue;
      await this.request("DELETE", this.repoPath(t, `/issues/${number}/labels/${encodeURIComponent(l)}`), undefined, [404]);
    }
    if (desired && !stateLabels.some((l) => normState(l) === normState(desired))) {
      await this.request("POST", this.repoPath(t, `/issues/${number}/labels`), { labels: [desired] });
    }
    if (tn === normState(this.cfg.closed_state)) {
      if (raw.state !== "closed") {
        await this.request("PATCH", this.repoPath(t, `/issues/${number}`), {
          state: "closed",
          state_reason: a.close_reason === "not_planned" ? "not_planned" : "completed",
        });
      }
    } else if (raw.state === "closed") {
      await this.request("PATCH", this.repoPath(t, `/issues/${number}`), { state: "open" });
    }
    return { ok: true, output: { state: target, label: desired } };
  }

  private async getRepoInfo(t: GitHubRepoTarget): Promise<{ clone_url: string; default_branch: string }> {
    const cached = this.repoInfo.get(t.full_name.toLowerCase());
    if (cached) return cached;
    const res = await this.request("GET", this.repoPath(t));
    const b = res.body;
    if (!isPlainObject(b) || typeof b.clone_url !== "string" || typeof b.default_branch !== "string") {
      throw new TrackerError("tracker_response", "unexpected repository payload");
    }
    const info = { clone_url: b.clone_url, default_branch: b.default_branch };
    this.repoInfo.set(t.full_name.toLowerCase(), info);
    return info;
  }

  private async toolPush(t: GitHubRepoTarget, a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const branch = typeof a.branch === "string" ? a.branch.trim() : "";
    if (!validBranch(branch)) return { ok: false, error: { code: "invalid_arguments", message: "invalid branch name" } };
    const info = await this.getRepoInfo(t);
    const protectedSet = new Set([info.default_branch, ...t.protected_branches].map((b) => b.toLowerCase()));
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

const ISSUE_ID_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;

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
