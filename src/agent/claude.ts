// Claude Code CLI coding-agent client.
//
// Targeted protocol: Claude Code headless streaming mode
//   claude -p --input-format stream-json --output-format stream-json --verbose
// Transport: newline-delimited JSON over stdio (stdout = protocol, stderr = diagnostics).
// Thread = Claude session (we pre-assign it with --session-id), turn = one user message → `result`.
// The process stays alive across continuation turns; we send another `user` message on stdin.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeConfig } from "../config.ts";
import { SymphonyError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { AgentEvent, TokenUsage } from "../types.ts";
import { killTree } from "../workspace.ts";
import { isPlainObject, shellQuote, truncate } from "../util.ts";

const MAX_LINE = 10 * 1024 * 1024;

export interface SessionOptions {
  cfg: ClaudeConfig;
  cwd: string;
  /** Child environment (already scrubbed of tracker secrets). */
  env: NodeJS.ProcessEnv;
  title: string;
  mcpConfigJson: string | null;
  logFile: string | null;
  log: Logger;
  onEvent: (ev: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  turn_id: string;
  session_id: string;
  result_text: string;
  num_turns: number | null;
  /** Cost of this turn alone (delta of the session-cumulative `total_cost_usd`). */
  cost_usd: number | null;
  permission_denials: unknown[];
}

/** Build the shell command string launched via `bash -lc`. */
export function buildClaudeCommand(cfg: ClaudeConfig, threadId: string, title: string, mcpConfigJson: string | null): string {
  const args: string[] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    threadId,
    "--permission-mode",
    cfg.permission_mode,
    "--permission-prompts",
    cfg.permission_prompts,
    "--name",
    title.slice(0, 200),
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (mcpConfigJson) args.push("--mcp-config", mcpConfigJson);
  if (cfg.strict_mcp_config) args.push("--strict-mcp-config");
  const allowed = [...cfg.allowed_tools];
  if (mcpConfigJson) allowed.push("mcp__symphony");
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (cfg.disallowed_tools.length) args.push("--disallowedTools", cfg.disallowed_tools.join(","));
  if (cfg.append_system_prompt) args.push("--append-system-prompt", cfg.append_system_prompt);
  if (cfg.max_budget_usd) args.push("--max-budget-usd", String(cfg.max_budget_usd));
  args.push(...cfg.extra_args);
  return `${cfg.command} ${args.map(shellQuote).join(" ")}`;
}

function extractUsage(u: unknown): TokenUsage | null {
  if (!isPlainObject(u)) return null;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const input = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  const output = n("output_tokens");
  if (input === 0 && output === 0 && typeof u.input_tokens !== "number") return null;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function summarizeAssistant(msg: unknown): string {
  if (!isPlainObject(msg) || !Array.isArray(msg.content)) return "";
  const parts: string[] = [];
  for (const c of msg.content) {
    if (!isPlainObject(c)) continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "tool_use" && typeof c.name === "string") {
      let hint = "";
      if (isPlainObject(c.input)) {
        const i = c.input;
        hint = String(i.command ?? i.file_path ?? i.pattern ?? i.description ?? "");
      }
      parts.push(`[tool] ${c.name}${hint ? ` ${hint}` : ""}`);
    }
  }
  return truncate(parts.join(" | ").replace(/\s+/g, " ").trim(), 400);
}

export class ClaudeSession {
  readonly threadId: string;
  private readonly opts: SessionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private turnCounter = 0;
  private initialized = false;
  private exited: { code: number | null; signal: string | null } | null = null;
  private stderrTail: string[] = [];
  private logStream: fs.WriteStream | null = null;
  private lineHandler: ((obj: unknown, raw: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private totals: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private totalCost = 0;
  /**
   * Per-API-message usage seen in `assistant` events of the current turn, keyed by message id.
   * Claude Code splits one API response into several `assistant` events (one per content block)
   * that repeat the same id, so the latest value per id wins instead of being summed.
   */
  private turnUsage = new Map<string, TokenUsage>();
  private readonly log: Logger;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.threadId = crypto.randomUUID();
    this.log = opts.log.child({ thread_id: this.threadId });
  }

  get pid(): string | null {
    return this.child?.pid ? String(this.child.pid) : null;
  }

  private emit(ev: Omit<AgentEvent, "timestamp" | "codex_app_server_pid">): void {
    this.opts.onEvent({ timestamp: new Date().toISOString(), codex_app_server_pid: this.pid, thread_id: this.threadId, ...ev });
  }

  /** Launch the subprocess in the workspace (SPEC §10.1). */
  async start(): Promise<void> {
    const { cfg, cwd } = this.opts;
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!path.isAbsolute(cwd) || !isDir) {
      throw new SymphonyError("invalid_workspace_cwd", `invalid workspace cwd ${cwd}`);
    }
    if (this.opts.logFile) {
      fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
      this.logStream = fs.createWriteStream(this.opts.logFile, { flags: "a" });
      this.logStream.on("error", (err) => {
        this.log.warn("agent log sink failed", { error: err });
        this.logStream = null;
      });
    }
    const command = buildClaudeCommand(cfg, this.threadId, this.opts.title, this.opts.mcpConfigJson);
    const env = { ...this.opts.env, ...this.resolveExtraEnv() };
    this.writeLog(`# launch cwd=${cwd}\n# command=${redactMcp(command)}\n`);
    const child = spawn("bash", ["-lc", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child;
    child.stdin.on("error", () => {
      /* EPIPE when the process dies; surfaced via exit */
    });
    child.stdout.on("data", (b: Buffer) => this.onStdout(b));
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      this.writeLog(s.replace(/^/gm, "[stderr] "));
      for (const line of s.split("\n")) if (line.trim()) this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50);
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.writeLog(`# exit code=${code} signal=${signal}\n`);
      this.exitHandler?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new SymphonyError("codex_not_found", `failed to spawn agent: ${err.message}`)));
    });
    this.log.info("agent process started", { pid: child.pid });

    // Detect immediate failures (missing binary => bash exit 127) before the first turn.
    await new Promise((r) => setTimeout(r, 150));
    if (this.exited) throw this.exitError();
  }

  private resolveExtraEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.cfg.env)) {
      const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v.trim());
      out[k] = m ? (process.env[m[1]] ?? "") : v;
    }
    return out;
  }

  private exitError(): SymphonyError {
    const code = this.exited?.code;
    const tail = this.stderrTail.slice(-5).join(" / ");
    if (code === 127) return new SymphonyError("codex_not_found", `agent command not found: ${this.opts.cfg.command} ${tail}`);
    return new SymphonyError("port_exit", `agent process exited (code=${code} signal=${this.exited?.signal}) ${tail}`.trim());
  }

  private writeLog(s: string): void {
    try {
      this.logStream?.write(s);
    } catch {
      /* ignore */
    }
  }

  private onStdout(b: Buffer): void {
    this.buf += b.toString("utf8");
    if (this.buf.length > MAX_LINE && !this.buf.includes("\n")) {
      this.emit({ event: "malformed", message: "line exceeded max size; dropped" });
      this.buf = "";
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.writeLog(line + "\n");
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        this.emit({ event: "malformed", message: truncate(line, 200) });
        continue;
      }
      this.lineHandler?.(obj, line);
    }
  }

  private send(obj: unknown): void {
    if (!this.child || this.exited) throw this.exitError();
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /**
   * Running thread totals including the in-progress turn, from the per-message usage that
   * `assistant` events carry. The turn's `result` usage replaces this estimate when it arrives.
   */
  private trackLiveUsage(msg: unknown): TokenUsage | null {
    if (!isPlainObject(msg)) return null;
    const u = extractUsage(msg.usage);
    if (!u) return null;
    const id = typeof msg.id === "string" ? msg.id : `anon-${this.turnUsage.size}`;
    const prev = this.turnUsage.get(id);
    this.turnUsage.set(id, {
      input_tokens: Math.max(prev?.input_tokens ?? 0, u.input_tokens),
      output_tokens: Math.max(prev?.output_tokens ?? 0, u.output_tokens),
      total_tokens: 0,
    });
    let input = this.totals.input_tokens;
    let output = this.totals.output_tokens;
    for (const v of this.turnUsage.values()) {
      input += v.input_tokens;
      output += v.output_tokens;
    }
    return { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }

  /** Run one turn: send a user message and stream until the `result` message (SPEC §10.3). */
  runTurn(prompt: string): Promise<TurnResult> {
    const { cfg, signal } = this.opts;
    const turnId = `turn-${++this.turnCounter}`;
    const sessionId = `${this.threadId}-${turnId}`;
    return new Promise<TurnResult>((resolve, reject) => {
      let silenceTimer: NodeJS.Timeout | null = null;
      let initTimer: NodeJS.Timeout | null = null;
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (initTimer) clearTimeout(initTimer);
        this.lineHandler = null;
        this.exitHandler = null;
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: SymphonyError) => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      const armSilence = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(
          () => fail(new SymphonyError("turn_timeout", `no agent output for ${cfg.turn_timeout_ms}ms`)),
          cfg.turn_timeout_ms,
        );
      };
      const onAbort = () => fail(new SymphonyError("turn_cancelled", "turn cancelled by orchestrator"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      this.exitHandler = () => fail(this.exitError());
      if (!this.initialized) {
        initTimer = setTimeout(
          () => fail(new SymphonyError("response_timeout", `agent did not initialize within ${cfg.read_timeout_ms}ms`)),
          cfg.read_timeout_ms,
        );
      }

      this.lineHandler = (obj) => {
        armSilence();
        if (!isPlainObject(obj)) {
          this.emit({ event: "malformed", session_id: sessionId, turn_id: turnId });
          return;
        }
        const type = obj.type;
        if (type === "system" && obj.subtype === "init") {
          if (initTimer) {
            clearTimeout(initTimer);
            initTimer = null;
          }
          if (!this.initialized) {
            this.initialized = true;
            this.emit({
              event: "session_started",
              session_id: sessionId,
              turn_id: turnId,
              message: `model=${String(obj.model ?? "?")}`,
              payload: { model: obj.model, tools: Array.isArray(obj.tools) ? obj.tools.length : null, mcp_servers: obj.mcp_servers },
            });
          }
          return;
        }
        if (type === "assistant") {
          const live = this.trackLiveUsage(obj.message);
          this.emit({
            event: "notification",
            session_id: sessionId,
            turn_id: turnId,
            message: summarizeAssistant(obj.message),
            ...(live ? { usage: live } : {}),
          });
          return;
        }
        if (type === "user") {
          this.emit({ event: "notification", session_id: sessionId, turn_id: turnId, message: "[tool result]" });
          return;
        }
        if (type === "rate_limit_event" || obj.rate_limit_info !== undefined) {
          this.emit({ event: "notification", session_id: sessionId, turn_id: turnId, rate_limits: obj.rate_limit_info ?? obj });
          return;
        }
        if (type === "control_request") {
          this.handleControlRequest(obj, sessionId, turnId);
          return;
        }
        if (type === "result") {
          const usage = extractUsage(obj.usage);
          this.turnUsage.clear();
          if (usage) {
            this.totals = {
              input_tokens: this.totals.input_tokens + usage.input_tokens,
              output_tokens: this.totals.output_tokens + usage.output_tokens,
              total_tokens: this.totals.total_tokens + usage.total_tokens,
            };
          }
          // `total_cost_usd` is cumulative for the whole Claude Code session (process), unlike
          // `usage`, which covers only this turn; so it replaces the running total.
          const sessionCost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null;
          const cost = sessionCost !== null ? Math.max(0, sessionCost - this.totalCost) : null;
          if (sessionCost !== null) this.totalCost = Math.max(this.totalCost, sessionCost);
          const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : [];
          const text = typeof obj.result === "string" ? obj.result : "";
          const isError = obj.is_error === true || obj.subtype !== "success";
          const base = {
            session_id: sessionId,
            turn_id: turnId,
            usage: { ...this.totals },
            cost_usd: this.totalCost,
            message: truncate(text.replace(/\s+/g, " ").trim(), 400),
            payload: { subtype: obj.subtype, num_turns: obj.num_turns, duration_ms: obj.duration_ms, permission_denials: denials.length },
          };
          if (isError) {
            this.emit({ event: "turn_failed", ...base });
            fail(new SymphonyError("turn_failed", `turn failed: ${String(obj.subtype)} ${truncate(text, 300)}`.trim()));
            return;
          }
          this.emit({ event: "turn_completed", ...base });
          if (settled) return;
          cleanup();
          resolve({
            turn_id: turnId,
            session_id: sessionId,
            result_text: text,
            num_turns: typeof obj.num_turns === "number" ? obj.num_turns : null,
            cost_usd: cost,
            permission_denials: denials,
          });
          return;
        }
        this.emit({ event: "other_message", session_id: sessionId, turn_id: turnId, message: String(type ?? "unknown") });
      };

      armSilence();
      try {
        this.send({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: this.threadId });
      } catch (err) {
        fail(err instanceof SymphonyError ? err : new SymphonyError("port_exit", String(err)));
      }
    });
  }

  /**
   * Approval policy for SDK-style control requests (only reachable when
   * claude.permission_prompts = "host"): command/file approvals are auto-approved (high-trust),
   * requests for user input are denied so the run never stalls.
   */
  private handleControlRequest(obj: Record<string, unknown>, sessionId: string, turnId: string): void {
    const requestId = obj.request_id;
    const req = isPlainObject(obj.request) ? obj.request : {};
    if (req.subtype === "can_use_tool") {
      const tool = String(req.tool_name ?? "");
      const userInput = /AskUser|UserQuestion/i.test(tool);
      const response = userInput
        ? { behavior: "deny", message: "No operator is available; proceed autonomously or record the blocker on the issue." }
        : { behavior: "allow", updatedInput: req.input ?? {} };
      this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
      this.emit({
        event: userInput ? "turn_input_required" : "approval_auto_approved",
        session_id: sessionId,
        turn_id: turnId,
        message: tool,
      });
      return;
    }
    this.send({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: `unsupported control request: ${String(req.subtype)}` },
    });
    this.emit({ event: "unsupported_tool_call", session_id: sessionId, turn_id: turnId, message: String(req.subtype) });
  }

  /** Stop the subprocess: close stdin, then TERM, then KILL the process group. */
  async stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.exited) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      const done = new Promise<void>((r) => (this.exited ? r() : child.once("exit", () => r())));
      const t1 = setTimeout(() => killTree(child.pid, "SIGTERM"), graceMs);
      const t2 = setTimeout(() => killTree(child.pid, "SIGKILL"), graceMs * 2);
      await Promise.race([done, new Promise((r) => setTimeout(r, graceMs * 3))]);
      clearTimeout(t1);
      clearTimeout(t2);
    }
    // Reap any leftover processes in the group.
    killTree(child.pid, "SIGKILL");
    await new Promise<void>((r) => {
      if (!this.logStream) return r();
      this.logStream.end(() => r());
    });
    this.logStream = null;
  }

  kill(): void {
    killTree(this.child?.pid, "SIGKILL");
  }
}

function redactMcp(cmd: string): string {
  return cmd.replace(/Bearer [0-9a-f]+/g, "Bearer ***");
}
