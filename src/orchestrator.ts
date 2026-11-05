// Orchestrator (SPEC §7, §8, §16). Owns the poll tick and the single authoritative in-memory state.
// Node's single-threaded event loop serializes mutations: every state change happens in a
// synchronous section, and claim/running checks are re-done synchronously right before dispatch.
import { buildConfig, validateCoreConfig, type ServiceConfig } from "./config.ts";
import { SymphonyError, TrackerError, errorSummary } from "./errors.ts";
import type { Logger } from "./log.ts";
import { runAgentAttempt } from "./agent/runner.ts";
import { ToolBridge } from "./agent/tool-bridge.ts";
import { buildTracker, type BuiltTracker } from "./tracker/index.ts";
import type { AgentEvent, Issue, TokenUsage, WorkflowDefinition } from "./types.ts";
import { isoOrNull, normState } from "./util.ts";
import { loadWorkflow, WorkflowWatcher } from "./workflow.ts";
import { WorkspaceManager } from "./workspace.ts";

export const CONTINUATION_DELAY_MS = 1000;
const RECENT_EVENTS = 100;

export interface RecentEvent {
  at: string;
  event: string;
  message: string | null;
}

type StopKind = "terminal" | "inactive" | "unroutable" | "missing" | "stalled" | "shutdown";

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  abort: AbortController;
  promise: Promise<void> | null;
  started_at: number;
  retry_attempt: number | null;
  workspace_path: string | null;
  log_files: string[];
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: number | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
  cost_usd: number;
  recent_events: RecentEvent[];
  stop: { kind: StopKind; cleanup: boolean } | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  due_at_wall: number;
  timer_handle: NodeJS.Timeout;
  error: string | null;
  url: string | null;
}

interface IssueHistory {
  issue_id: string;
  identifier: string;
  url: string | null;
  workspace_path: string | null;
  log_files: string[];
  restart_count: number;
  last_error: string | null;
  recent_events: RecentEvent[];
  last_state: string | null;
  last_status: string;
}

export interface Effective {
  cfg: ServiceConfig;
  workflow: WorkflowDefinition;
  tracker: BuiltTracker;
}

export interface OrchestratorOptions {
  workflowPath: string;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  /** Override tracker construction (tests / embedding). */
  trackerBuilder?: (cfg: ServiceConfig, log: Logger) => BuiltTracker;
  /** Disable the MCP tool bridge (tests). */
  disableToolBridge?: boolean;
  watchPollMs?: number;
}

export function retryDelayMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(10000 * 2 ** Math.max(0, attempt - 1), maxBackoffMs);
}

/** Dispatch sort (SPEC §8.2): priority 1..4 first, then oldest created, then identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  const bucket = (p: number | null) => (p !== null && Number.isInteger(p) && p >= 1 && p <= 4 ? p : 99);
  return [...issues].sort((a, b) => {
    const pa = bucket(a.priority);
    const pb = bucket(b.priority);
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const cb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

export class Orchestrator {
  readonly log: Logger;
  private readonly opts: OrchestratorOptions;
  private readonly env: NodeJS.ProcessEnv;

  effective: Effective | null = null;
  lastConfigError: string | null = null;
  private workflowInvalid = false;

  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly retryAttempts = new Map<string, RetryEntry>();
  readonly completed = new Set<string>();
  codexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0, cost_usd: 0 };
  rateLimits: unknown = null;
  private history = new Map<string, IssueHistory>();

  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private refreshPending = false;
  private stopped = false;
  private watcher: WorkflowWatcher | null = null;
  private bridge: ToolBridge | null = null;
  readonly workspaces: WorkspaceManager;
  lastTickAt: number | null = null;
  lastTickError: string | null = null;
  private listeners = new Set<() => void>();

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.log = opts.log;
    this.env = opts.env ?? process.env;
    this.workspaces = new WorkspaceManager({
      root: () => this.cfg().workspace.root,
      hooks: () => this.cfg().hooks,
      log: this.log.child({ component: "workspace" }),
    });
  }

  cfg(): ServiceConfig {
    if (!this.effective) throw new Error("orchestrator has no effective config");
    return this.effective.cfg;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* observers never affect correctness */
      }
    }
  }

  // ---- Workflow load / reload (SPEC §6.2) -------------------------------------------------------

  private loadEffective(): Effective {
    const workflow = loadWorkflow(this.opts.workflowPath, this.env);
    const cfg = buildConfig(workflow, this.opts.workflowPath, this.env);
    validateCoreConfig(cfg);
    const trackerLog = this.log.child({ component: "tracker" });
    const tracker = this.opts.trackerBuilder ? this.opts.trackerBuilder(cfg, trackerLog) : buildTracker(cfg, trackerLog, this.env);
    return { cfg, workflow, tracker };
  }

  /** Re-read WORKFLOW.md; on failure keep the last known good config (SPEC §6.2). */
  reload(reason: string): boolean {
    try {
      const eff = this.loadEffective();
      this.effective = eff;
      this.lastConfigError = null;
      this.workflowInvalid = false;
      if (eff.workflow.source_files) this.watcher?.setFiles(eff.workflow.source_files);
      else this.watcher?.markSeen();
      this.applyLogging(eff.cfg);
      this.log.info("workflow reloaded", {
        reason,
        tracker_kind: eff.cfg.tracker.kind,
        poll_interval_ms: eff.cfg.polling.interval_ms,
        max_concurrent_agents: eff.cfg.agent.max_concurrent_agents,
      });
      void this.prepareTracker();
      this.notify();
      return true;
    } catch (err) {
      this.lastConfigError = errorSummary(err);
      this.workflowInvalid = true;
      this.watcher?.markSeen();
      this.log.error("workflow reload failed; keeping last known good configuration", { reason, error: this.lastConfigError });
      this.notify();
      return false;
    }
  }

  private applyLogging(cfg: ServiceConfig): void {
    if (cfg.logging.file) this.log.setFile(cfg.logging.file);
    if (cfg.logging.level && ["debug", "info", "warn", "error"].includes(cfg.logging.level)) {
      this.log.setLevel(cfg.logging.level as "debug");
    }
  }

  // ---- Lifecycle (SPEC §16.1) -------------------------------------------------------------------

  async start(): Promise<void> {
    // Startup validation: fail startup on invalid config.
    try {
      this.effective = this.loadEffective();
    } catch (err) {
      this.log.error("startup validation failed", { error: errorSummary(err) });
      throw err;
    }
    this.applyLogging(this.cfg());
    this.log.info("symphony starting", {
      workflow: this.cfg().workflow_path,
      tracker_kind: this.cfg().tracker.kind,
      workspace_root: this.cfg().workspace.root,
      active_states: this.effective.tracker.activeStates.join(","),
      terminal_states: this.effective.tracker.terminalStates.join(","),
    });
    this.watcher = new WorkflowWatcher(this.opts.workflowPath, () => this.reload("file_changed"), this.opts.watchPollMs);
    if (this.effective.workflow.source_files) this.watcher.setFiles(this.effective.workflow.source_files);
    if (!this.opts.disableToolBridge) {
      this.bridge = new ToolBridge(this.log);
      await this.bridge.start();
    }
    await this.prepareTracker();
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.watcher?.close();
    for (const r of this.retryAttempts.values()) clearTimeout(r.timer_handle);
    this.retryAttempts.clear();
    const waits: Promise<void>[] = [];
    for (const e of this.running.values()) {
      if (!e.stop) e.stop = { kind: "shutdown", cleanup: false };
      e.abort.abort();
      if (e.promise) waits.push(e.promise);
    }
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 15000))]);
    await this.bridge?.stop();
    this.log.info("symphony stopped", {});
  }

  /** Tracker-side setup (e.g. create missing GitHub labels). Failures are logged, never fatal. */
  private async prepareTracker(): Promise<void> {
    const adapter = this.effective?.tracker.adapter;
    if (!adapter?.prepare) return;
    try {
      for (const line of await adapter.prepare("startup")) this.log.info("tracker setup", { result: line });
    } catch (err) {
      this.log.warn("tracker setup failed; continuing", { error: errorSummary(err) });
    }
  }

  /** Env for `before_remove`: issue id plus adapter-provided vars (e.g. its repository). */
  private removeEnv(issue: Issue): Record<string, string> {
    let extra: Record<string, string> = {};
    try {
      extra = this.effective?.tracker.adapter.issueEnvironment?.(issue) ?? {};
    } catch {
      /* best effort */
    }
    return { ...extra, SYMPHONY_ISSUE_ID: issue.id };
  }

  private async startupTerminalCleanup(): Promise<void> {
    const eff = this.effective!;
    try {
      const issues = await eff.tracker.adapter.fetchIssuesByStates(eff.tracker.terminalStates);
      let removed = 0;
      for (const i of issues) {
        if (await this.workspaces.removeWorkspace(i.identifier, this.removeEnv(i))) removed++;
      }
      this.log.info("startup terminal cleanup completed", { terminal_issues: issues.length, removed });
    } catch (err) {
      this.log.warn("startup terminal cleanup failed; continuing", { error: errorSummary(err) });
    }
  }

  // ---- Tick (SPEC §8.1, §16.2) ------------------------------------------------------------------

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.tick();
    }, delayMs);
  }

  /** Queue an immediate poll + reconcile. Returns whether the request was coalesced. */
  requestRefresh(): { coalesced: boolean } {
    if (this.ticking) {
      const coalesced = this.refreshPending;
      this.refreshPending = true;
      return { coalesced };
    }
    const coalesced = this.tickTimer !== null && this.refreshPending;
    this.refreshPending = true;
    this.scheduleTick(0);
    return { coalesced };
  }

  async tick(): Promise<void> {
    if (this.stopped || !this.effective) return;
    if (this.ticking) {
      this.refreshPending = true;
      return;
    }
    this.ticking = true;
    this.refreshPending = false;
    let nextDelay: number | null = null;
    try {
      // Defensive reload in case watch events were missed.
      if (this.watcher?.hasChanged()) this.reload("fingerprint_changed");

      await this.reconcileRunningIssues();

      // Dispatch preflight (SPEC §6.3).
      if (this.workflowInvalid) {
        this.lastTickError = `dispatch skipped: ${this.lastConfigError}`;
        this.log.error("dispatch preflight failed; skipping dispatch", { error: this.lastConfigError });
        return;
      }
      const eff = this.effective;
      let candidates: Issue[];
      try {
        candidates = await eff.tracker.adapter.fetchIssuesByStates(eff.tracker.activeStates);
      } catch (err) {
        this.lastTickError = `candidate fetch failed: ${errorSummary(err)}`;
        this.log.error("candidate fetch failed; skipping dispatch this tick", { error: errorSummary(err) });
        if (err instanceof TrackerError && err.retryAfterMs) nextDelay = Math.max(eff.cfg.polling.interval_ms, err.retryAfterMs);
        return;
      }
      this.lastTickError = null;
      for (const issue of sortForDispatch(candidates)) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) this.dispatchIssue(issue, null);
      }
    } catch (err) {
      this.lastTickError = errorSummary(err);
      this.log.error("tick failed", { error: errorSummary(err) });
    } finally {
      this.lastTickAt = Date.now();
      this.ticking = false;
      this.notify();
      if (!this.stopped) {
        if (this.refreshPending) this.scheduleTick(0);
        else this.scheduleTick(nextDelay ?? this.effective!.cfg.polling.interval_ms);
      }
    }
  }

  // ---- Eligibility & slots (SPEC §8.2, §8.3) ----------------------------------------------------

  private isActive(state: string): boolean {
    const n = normState(state);
    return this.effective!.tracker.activeStates.some((s) => normState(s) === n);
  }

  private isTerminal(state: string): boolean {
    const n = normState(state);
    return this.effective!.tracker.terminalStates.some((s) => normState(s) === n);
  }

  /** dispatchable + every required label (case/whitespace-insensitive; blank label matches none). */
  issueRoutable(issue: Issue): boolean {
    if (!issue.dispatchable) return false;
    const have = new Set(issue.labels.map(normState));
    for (const l of this.cfg().tracker.required_labels) {
      const n = normState(l);
      if (!n || !have.has(n)) return false;
    }
    return true;
  }

  availableSlots(): number {
    return Math.max(this.cfg().agent.max_concurrent_agents - this.running.size, 0);
  }

  private stateSlotsAvailable(state: string): boolean {
    const n = normState(state);
    const limit = this.cfg().agent.max_concurrent_agents_by_state[n] ?? this.cfg().agent.max_concurrent_agents;
    let count = 0;
    for (const e of this.running.values()) if (normState(e.issue.state) === n) count++;
    return count < limit;
  }

  private hasRequiredFields(i: Issue): boolean {
    return Boolean(i.id && i.identifier && i.title && i.state);
  }

  shouldDispatch(issue: Issue): boolean {
    return (
      this.hasRequiredFields(issue) &&
      this.isActive(issue.state) &&
      !this.isTerminal(issue.state) &&
      this.issueRoutable(issue) &&
      !this.running.has(issue.id) &&
      !this.claimed.has(issue.id) &&
      this.availableSlots() > 0 &&
      this.stateSlotsAvailable(issue.state)
    );
  }

  // ---- Dispatch (SPEC §16.4) --------------------------------------------------------------------

  dispatchIssue(issue: Issue, attempt: number | null): void {
    const eff = this.effective!;
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const abort = new AbortController();
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      abort,
      promise: null,
      started_at: Date.now(),
      retry_attempt: attempt,
      workspace_path: null,
      log_files: [],
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      cost_usd: 0,
      recent_events: [],
      stop: null,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const prevRetry = this.retryAttempts.get(issue.id);
    if (prevRetry) clearTimeout(prevRetry.timer_handle);
    this.retryAttempts.delete(issue.id);
    const hist = this.historyFor(issue);
    if (attempt !== null) hist.restart_count++;
    hist.last_status = "running";
    log.info("dispatching issue", { attempt, state: issue.state });

    let workerLog = log;
    const p = runAgentAttempt({
      issue,
      attempt,
      cfg: eff.cfg,
      promptTemplate: eff.workflow.prompt_template,
      tracker: eff.tracker.adapter,
      activeStates: eff.tracker.activeStates,
      isRoutable: (i) => this.issueRoutable(i),
      workspaces: this.workspaces,
      bridge: this.bridge,
      log,
      signal: abort.signal,
      onEvent: (ev) => {
        if (ev.session_id && ev.session_id !== entry.session_id) workerLog = log.child({ session_id: ev.session_id });
        this.onAgentEvent(entry, ev, workerLog);
      },
      onWorkspace: (wp) => {
        entry.workspace_path = wp;
        hist.workspace_path = wp;
      },
      onIssueRefresh: (i) => {
        if (this.running.get(issue.id) === entry) entry.issue = i;
      },
      onLogFile: (f) => {
        entry.log_files.push(f);
        hist.log_files = [...entry.log_files];
      },
    });
    entry.promise = p.then(
      () => this.onWorkerExit(entry, null),
      (err) => this.onWorkerExit(entry, err),
    );
    this.notify();
  }

  // ---- Agent events (SPEC §10.4, §13.5) ---------------------------------------------------------

  private onAgentEvent(entry: RunningEntry, ev: AgentEvent, log: Logger): void {
    if (this.running.get(entry.issue_id) !== entry) return;
    const at = Date.parse(ev.timestamp) || Date.now();
    entry.last_codex_event = ev.event;
    entry.last_codex_timestamp = at;
    if (ev.message !== undefined) entry.last_codex_message = ev.message ?? null;
    if (ev.codex_app_server_pid) entry.codex_app_server_pid = ev.codex_app_server_pid;
    if (ev.thread_id) entry.thread_id = ev.thread_id;
    if (ev.turn_id && ev.turn_id !== entry.turn_id) {
      entry.turn_id = ev.turn_id;
      entry.turn_count++;
    }
    if (ev.session_id) entry.session_id = ev.session_id;
    if (ev.usage) this.applyUsage(entry, ev.usage);
    if (typeof ev.cost_usd === "number" && ev.cost_usd > entry.cost_usd) {
      this.codexTotals.cost_usd += ev.cost_usd - entry.cost_usd;
      entry.cost_usd = ev.cost_usd;
    }
    if (ev.rate_limits !== undefined) this.rateLimits = ev.rate_limits;

    const rec: RecentEvent = { at: ev.timestamp, event: ev.event, message: ev.message ?? null };
    entry.recent_events.push(rec);
    if (entry.recent_events.length > RECENT_EVENTS) entry.recent_events.shift();
    const hist = this.history.get(entry.identifier);
    if (hist) hist.recent_events = entry.recent_events;

    if (ev.event === "notification" || ev.event === "other_message") {
      log.debug("agent event", { event: ev.event, message: ev.message });
    } else {
      log.info("agent event", { event: ev.event, message: ev.message, total_tokens: ev.usage?.total_tokens });
    }
  }

  /** Absolute thread totals → deltas vs last reported, avoiding double counting. */
  private applyUsage(entry: RunningEntry, u: TokenUsage): void {
    const dIn = Math.max(0, u.input_tokens - entry.last_reported_input_tokens);
    const dOut = Math.max(0, u.output_tokens - entry.last_reported_output_tokens);
    const dTot = Math.max(0, u.total_tokens - entry.last_reported_total_tokens);
    entry.last_reported_input_tokens = Math.max(entry.last_reported_input_tokens, u.input_tokens);
    entry.last_reported_output_tokens = Math.max(entry.last_reported_output_tokens, u.output_tokens);
    entry.last_reported_total_tokens = Math.max(entry.last_reported_total_tokens, u.total_tokens);
    entry.codex_input_tokens += dIn;
    entry.codex_output_tokens += dOut;
    entry.codex_total_tokens += dTot;
    this.codexTotals.input_tokens += dIn;
    this.codexTotals.output_tokens += dOut;
    this.codexTotals.total_tokens += dTot;
  }

  // ---- Worker exit & retries (SPEC §16.6) -------------------------------------------------------

  private async onWorkerExit(entry: RunningEntry, err: unknown): Promise<void> {
    if (this.running.get(entry.issue_id) !== entry) return;
    this.running.delete(entry.issue_id);
    this.codexTotals.seconds_running += (Date.now() - entry.started_at) / 1000;
    const log = this.log.child({ issue_id: entry.issue_id, issue_identifier: entry.identifier, session_id: entry.session_id ?? undefined });
    const hist = this.historyFor(entry.issue);
    hist.last_state = entry.issue.state;

    if (entry.stop) {
      const { kind, cleanup } = entry.stop;
      if (kind === "stalled") {
        const attempt = (entry.retry_attempt ?? 0) + 1;
        hist.last_error = "stalled: no agent activity";
        hist.last_status = "retrying";
        log.warn("worker stalled; retrying", { attempt });
        this.scheduleRetry(entry.issue_id, attempt, {
          identifier: entry.identifier,
          error: "stalled: no agent activity",
          delayMs: retryDelayMs(attempt, this.cfg().agent.max_retry_backoff_ms),
          url: entry.issue.url,
        });
      } else {
        this.claimed.delete(entry.issue_id);
        hist.last_status = "released";
        log.info("worker stopped by reconciliation; claim released", { reason: kind, cleanup_workspace: cleanup });
        if (cleanup) await this.workspaces.removeWorkspace(entry.identifier, this.removeEnv(entry.issue));
      }
      this.notify();
      return;
    }

    if (this.stopped) return;
    if (err === null) {
      this.completed.add(entry.issue_id);
      hist.last_status = "continuation";
      log.info("worker completed; scheduling continuation check", {});
      this.scheduleRetry(entry.issue_id, 1, {
        identifier: entry.identifier,
        error: null,
        delayMs: CONTINUATION_DELAY_MS,
        url: entry.issue.url,
      });
    } else {
      const attempt = (entry.retry_attempt ?? 0) + 1;
      const reason = errorSummary(err);
      hist.last_error = reason;
      hist.last_status = "retrying";
      const delay = retryDelayMs(attempt, this.cfg().agent.max_retry_backoff_ms);
      log.warn("worker failed; retrying", { attempt, delay_ms: delay, error: reason });
      this.scheduleRetry(entry.issue_id, attempt, {
        identifier: entry.identifier,
        error: `worker exited: ${reason}`,
        delayMs: delay,
        url: entry.issue.url,
      });
    }
    this.notify();
  }

  scheduleRetry(
    issueId: string,
    attempt: number,
    o: { identifier: string; error: string | null; delayMs: number; url?: string | null },
  ): void {
    const existing = this.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer_handle);
    if (this.stopped) return;
    const now = performance.now();
    const timer = setTimeout(() => void this.onRetryTimer(issueId), o.delayMs);
    this.retryAttempts.set(issueId, {
      issue_id: issueId,
      identifier: o.identifier,
      attempt,
      due_at_ms: now + o.delayMs,
      due_at_wall: Date.now() + o.delayMs,
      timer_handle: timer,
      error: o.error,
      url: o.url ?? null,
    });
    this.claimed.add(issueId);
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const entry = this.retryAttempts.get(issueId);
    if (!entry || this.stopped) return;
    this.retryAttempts.delete(issueId);
    const log = this.log.child({ issue_id: issueId, issue_identifier: entry.identifier });
    const backoff = (a: number) => retryDelayMs(a, this.cfg().agent.max_retry_backoff_ms);

    let refreshed: Issue[];
    try {
      refreshed = await this.effective!.tracker.adapter.fetchIssuesByIds([issueId]);
    } catch (err) {
      log.warn("retry refresh failed", { error: errorSummary(err) });
      this.scheduleRetry(issueId, entry.attempt + 1, {
        identifier: entry.identifier,
        error: "retry refresh failed",
        delayMs: backoff(entry.attempt + 1),
        url: entry.url,
      });
      return;
    }
    // Something else may have taken over while we awaited.
    if (this.running.has(issueId) || this.retryAttempts.has(issueId) || this.stopped) return;

    const issue = refreshed.find((i) => i.id === issueId);
    if (!issue) {
      this.claimed.delete(issueId);
      log.info("retry: issue no longer visible; claim released", {});
      this.notify();
      return;
    }
    if (this.isTerminal(issue.state)) {
      this.claimed.delete(issueId);
      log.info("retry: issue is terminal; cleaning workspace and releasing", { state: issue.state });
      await this.workspaces.removeWorkspace(issue.identifier, this.removeEnv(issue));
      this.notify();
      return;
    }
    if (this.workflowInvalid) {
      this.scheduleRetry(issueId, entry.attempt + 1, {
        identifier: issue.identifier,
        error: `dispatch preflight failed: ${this.lastConfigError}`,
        delayMs: backoff(entry.attempt + 1),
        url: issue.url,
      });
      return;
    }
    if (!this.isActive(issue.state) || !this.issueRoutable(issue)) {
      this.claimed.delete(issueId);
      log.info("retry: issue not eligible; claim released", { state: issue.state, dispatchable: issue.dispatchable });
      this.notify();
      return;
    }
    if (this.availableSlots() <= 0 || !this.stateSlotsAvailable(issue.state)) {
      this.scheduleRetry(issueId, entry.attempt + 1, {
        identifier: issue.identifier,
        error: "no available orchestrator slots",
        delayMs: backoff(entry.attempt + 1),
        url: issue.url,
      });
      this.notify();
      return;
    }
    this.dispatchIssue(issue, entry.attempt);
  }

  // ---- Reconciliation (SPEC §8.5, §16.3) --------------------------------------------------------

  private terminate(entry: RunningEntry, kind: StopKind, cleanup: boolean): void {
    if (entry.stop) return;
    entry.stop = { kind, cleanup };
    this.log.info("terminating worker", {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      session_id: entry.session_id ?? undefined,
      reason: kind,
      cleanup_workspace: cleanup,
    });
    entry.abort.abort();
  }

  async reconcileRunningIssues(): Promise<void> {
    // Part A: stall detection
    const stallMs = this.cfg().claude.stall_timeout_ms;
    if (stallMs > 0) {
      const now = Date.now();
      for (const e of this.running.values()) {
        if (e.stop) continue;
        const since = e.last_codex_timestamp ?? e.started_at;
        if (now - since > stallMs) this.terminate(e, "stalled", false);
      }
    }

    // Part B: tracker state refresh
    const ids = [...this.running.values()].filter((e) => !e.stop).map((e) => e.issue_id);
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.effective!.tracker.adapter.fetchIssuesByIds(ids);
    } catch (err) {
      this.log.debug("running-state refresh failed; keeping workers running", { error: errorSummary(err) });
      return;
    }
    const returned = new Set<string>();
    for (const issue of refreshed) {
      returned.add(issue.id);
      const e = this.running.get(issue.id);
      if (!e || e.stop) continue;
      if (this.isTerminal(issue.state)) {
        e.issue = issue;
        this.terminate(e, "terminal", true);
      } else if (this.isActive(issue.state) && this.issueRoutable(issue)) {
        e.issue = issue;
      } else if (this.isActive(issue.state)) {
        e.issue = issue;
        this.terminate(e, "unroutable", false);
      } else {
        e.issue = issue;
        this.terminate(e, "inactive", false);
      }
    }
    for (const id of ids) {
      if (returned.has(id)) continue;
      const e = this.running.get(id);
      if (e && !e.stop) this.terminate(e, "missing", false);
    }
  }

  // ---- Observability (SPEC §13.3, §13.7) --------------------------------------------------------

  private historyFor(issue: Issue): IssueHistory {
    let h = this.history.get(issue.identifier);
    if (!h) {
      h = {
        issue_id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        workspace_path: null,
        log_files: [],
        restart_count: 0,
        last_error: null,
        recent_events: [],
        last_state: issue.state,
        last_status: "unclaimed",
      };
      this.history.set(issue.identifier, h);
      if (this.history.size > 1000) this.history.delete(this.history.keys().next().value!);
    }
    h.url = issue.url ?? h.url;
    return h;
  }

  private runningRow(e: RunningEntry) {
    return {
      issue_id: e.issue_id,
      issue_identifier: e.identifier,
      issue_url: e.issue.url,
      title: e.issue.title,
      state: e.issue.state,
      session_id: e.session_id,
      thread_id: e.thread_id,
      pid: e.codex_app_server_pid,
      turn_count: e.turn_count,
      retry_attempt: e.retry_attempt,
      last_event: e.last_codex_event,
      last_message: e.last_codex_message ?? "",
      started_at: isoOrNull(e.started_at),
      last_event_at: isoOrNull(e.last_codex_timestamp),
      stopping: e.stop?.kind ?? null,
      workspace_path: e.workspace_path,
      tokens: {
        input_tokens: e.codex_input_tokens,
        output_tokens: e.codex_output_tokens,
        total_tokens: e.codex_total_tokens,
      },
      cost_usd: e.cost_usd,
      recent_events: e.recent_events,
    };
  }

  private retryRow(r: RetryEntry) {
    return {
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      issue_url: r.url,
      attempt: r.attempt,
      due_at: new Date(r.due_at_wall).toISOString(),
      error: r.error,
    };
  }

  snapshot() {
    const now = Date.now();
    let active = 0;
    for (const e of this.running.values()) active += (now - e.started_at) / 1000;
    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: this.running.size, retrying: this.retryAttempts.size, claimed: this.claimed.size },
      running: [...this.running.values()].map((e) => this.runningRow(e)),
      retrying: [...this.retryAttempts.values()].sort((a, b) => a.due_at_ms - b.due_at_ms).map((r) => this.retryRow(r)),
      codex_totals: {
        input_tokens: this.codexTotals.input_tokens,
        output_tokens: this.codexTotals.output_tokens,
        total_tokens: this.codexTotals.total_tokens,
        seconds_running: Math.round((this.codexTotals.seconds_running + active) * 10) / 10,
        cost_usd: Math.round(this.codexTotals.cost_usd * 10000) / 10000,
      },
      rate_limits: this.rateLimits ?? null,
      health: {
        workflow_path: this.effective?.cfg.workflow_path ?? null,
        config_error: this.lastConfigError,
        last_tick_at: isoOrNull(this.lastTickAt),
        last_tick_error: this.lastTickError,
        poll_interval_ms: this.effective?.cfg.polling.interval_ms ?? null,
        max_concurrent_agents: this.effective?.cfg.agent.max_concurrent_agents ?? null,
        tracker_kind: this.effective?.cfg.tracker.kind ?? null,
      },
    };
  }

  issueDetail(identifier: string) {
    const running = [...this.running.values()].find((e) => e.identifier === identifier) ?? null;
    const retry = [...this.retryAttempts.values()].find((r) => r.identifier === identifier) ?? null;
    const hist = this.history.get(identifier) ?? null;
    if (!running && !retry && !hist) return null;
    const issueId = running?.issue_id ?? retry?.issue_id ?? hist!.issue_id;
    const logs = (running?.log_files ?? hist?.log_files ?? []).map((p, i, arr) => ({
      label: i === arr.length - 1 ? "latest" : `run-${i + 1}`,
      path: p,
      url: null,
    }));
    return {
      issue_identifier: identifier,
      issue_id: issueId,
      issue_url: running?.issue.url ?? retry?.url ?? hist?.url ?? null,
      status: running ? "running" : retry ? "retrying" : (hist?.last_status ?? "unknown"),
      workspace: { path: running?.workspace_path ?? hist?.workspace_path ?? this.safeWorkspacePath(identifier) },
      attempts: {
        restart_count: hist?.restart_count ?? 0,
        current_retry_attempt: running?.retry_attempt ?? retry?.attempt ?? null,
      },
      running: running ? this.runningRow(running) : null,
      retry: retry ? this.retryRow(retry) : null,
      logs: { codex_session_logs: logs },
      recent_events: running?.recent_events ?? hist?.recent_events ?? [],
      last_error: hist?.last_error ?? null,
      tracked: { claimed: this.claimed.has(issueId), completed_once: this.completed.has(issueId), last_state: hist?.last_state ?? null },
    };
  }

  private safeWorkspacePath(identifier: string): string | null {
    try {
      return this.workspaces.pathFor(identifier);
    } catch {
      return null;
    }
  }
}

export { SymphonyError };
