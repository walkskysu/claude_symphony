// Workspace Manager + hooks (SPEC §9).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SymphonyError } from "./errors.ts";
import type { HooksConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { isInside, truncate } from "./util.ts";

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

/**
 * Sanitize an identifier into a workspace key (SPEC §4.2, §9.5 invariant 3). If sanitization
 * changes anything, a 64-bit stable hash suffix of the original identifier is appended.
 */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  // "." and ".." are not usable directory names; treat them as changed.
  if (sanitized === identifier && sanitized !== "." && sanitized !== ".." && sanitized !== "") return sanitized;
  const hash = crypto.createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 16);
  return `${sanitized}-${hash}`;
}

export function workspacePathFor(root: string, identifier: string): string {
  const absRoot = path.resolve(root);
  const p = path.resolve(absRoot, workspaceKey(identifier));
  assertInsideRoot(absRoot, p);
  return p;
}

export function assertInsideRoot(root: string, p: string): void {
  const absRoot = path.resolve(root);
  const abs = path.resolve(p);
  if (abs === absRoot || !isInside(absRoot, abs)) {
    throw new SymphonyError("workspace_outside_root", `workspace path ${abs} is not inside workspace root ${absRoot}`);
  }
}

export interface HookRunOptions {
  env?: NodeJS.ProcessEnv;
  log: Logger;
}

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
}

/** Run a shell script with `bash -lc` in `cwd`, with a hard timeout that kills the process group. */
export function runShell(script: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<HookResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn("bash", ["-lc", script], {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const append = (b: Buffer) => {
      if (output.length < 64 * 1024) output += b.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut, output: output + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, timedOut, output });
    });
  });
}

export function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export class WorkspaceManager {
  private readonly getRoot: () => string;
  private readonly getHooks: () => HooksConfig;
  private readonly hookEnv: () => NodeJS.ProcessEnv;
  private readonly log: Logger;

  constructor(opts: {
    root: () => string;
    hooks: () => HooksConfig;
    hookEnv?: () => NodeJS.ProcessEnv;
    log: Logger;
  }) {
    this.getRoot = opts.root;
    this.getHooks = opts.hooks;
    this.hookEnv = opts.hookEnv ?? (() => process.env);
    this.log = opts.log;
  }

  root(): string {
    return path.resolve(this.getRoot());
  }

  pathFor(identifier: string): string {
    return workspacePathFor(this.root(), identifier);
  }

  /** Ensure the workspace dir exists (SPEC §9.2). Runs `after_create` only on fresh creation. */
  async createForIssue(identifier: string, extraEnv: Record<string, string> = {}): Promise<Workspace> {
    const root = this.root();
    const key = workspaceKey(identifier);
    const wsPath = workspacePathFor(root, identifier);
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      throw new SymphonyError("workspace_error", `cannot create workspace root ${root}: ${(err as Error).message}`);
    }
    let createdNow = false;
    try {
      fs.mkdirSync(wsPath);
      createdNow = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        throw new SymphonyError("workspace_error", `cannot create workspace ${wsPath}: ${e.message}`);
      }
      const st = fs.lstatSync(wsPath);
      if (!st.isDirectory()) {
        // Policy: fail safely rather than deleting an unexpected non-directory path.
        throw new SymphonyError("workspace_error", `workspace path ${wsPath} exists and is not a directory`);
      }
    }
    // Resolve symlinks in the root and re-check containment.
    const real = fs.realpathSync(wsPath);
    const realRoot = fs.realpathSync(root);
    assertInsideRoot(realRoot, real);

    const ws: Workspace = { path: wsPath, workspace_key: key, created_now: createdNow };
    if (createdNow) {
      try {
        await this.runHook("after_create", ws.path, identifier, extraEnv, true);
      } catch (err) {
        // Remove the partially prepared, brand-new directory (SPEC §9.3 allows this).
        fs.rmSync(wsPath, { recursive: true, force: true });
        throw err;
      }
    }
    return ws;
  }

  /**
   * Run a hook. `fatal` hooks throw on failure/timeout; non-fatal hooks log and return.
   */
  async runHook(
    name: HookName,
    cwd: string,
    identifier: string,
    extraEnv: Record<string, string> = {},
    fatal = name === "after_create" || name === "before_run",
  ): Promise<void> {
    const hooks = this.getHooks();
    const script = hooks[name];
    if (!script || !script.trim()) return;
    const log = this.log.child({ hook: name, issue_identifier: identifier });
    log.info("hook started", { cwd });
    const env = {
      ...this.hookEnv(),
      SYMPHONY_HOOK: name,
      SYMPHONY_WORKSPACE: cwd,
      SYMPHONY_ISSUE_IDENTIFIER: identifier,
      ...extraEnv,
    };
    const res = await runShell(script, cwd, hooks.timeout_ms, env);
    if (res.ok) {
      log.info("hook completed", { output: truncate(res.output.trim(), 500) || undefined });
      return;
    }
    const reason = res.timedOut ? `timed out after ${hooks.timeout_ms}ms` : `exited with code ${res.code}`;
    if (fatal) {
      log.error("hook failed", { reason, output: truncate(res.output.trim(), 2000) });
      throw new SymphonyError(res.timedOut ? "hook_timeout" : "hook_failed", `${name} hook ${reason}`);
    }
    log.warn("hook failed (ignored)", { reason, output: truncate(res.output.trim(), 2000) });
  }

  /** Remove a workspace (runs `before_remove`, failures ignored). */
  async removeWorkspace(identifier: string, extraEnv: Record<string, string> = {}): Promise<boolean> {
    let wsPath: string;
    try {
      wsPath = this.pathFor(identifier);
    } catch (err) {
      this.log.warn("refusing to remove workspace", { issue_identifier: identifier, error: err });
      return false;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(wsPath);
    } catch {
      return false;
    }
    if (st.isDirectory()) {
      await this.runHook("before_remove", wsPath, identifier, extraEnv, false);
    }
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
      this.log.info("workspace removed", { issue_identifier: identifier, path: wsPath });
      return true;
    } catch (err) {
      this.log.warn("workspace removal failed", { issue_identifier: identifier, path: wsPath, error: err });
      return false;
    }
  }
}
