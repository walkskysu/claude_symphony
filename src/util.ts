import os from "node:os";
import path from "node:path";

/** Trim + lowercase for case-insensitive scheduler comparisons (SPEC §4.2). */
export function normState(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const VAR_BRACED_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** If `v` is exactly `$NAME` / `${NAME}` return NAME, else null. */
export function varRef(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const m = VAR_RE.exec(t) ?? VAR_BRACED_RE.exec(t);
  return m ? m[1] : null;
}

/**
 * Resolve a `$VAR_NAME` reference. Non-reference values are returned unchanged.
 * Empty / unset env values resolve to "".
 */
export function resolveVar(v: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const name = varRef(v);
  if (!name) return v;
  return env[name] ?? "";
}

/** Path-valued fields: `$VAR` expansion (whole value or leading segment), then `~` expansion. */
export function resolvePathValue(v: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = v.trim();
  const name = varRef(out);
  if (name) out = env[name] ?? "";
  else {
    out = out.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?=\/|$)/, (_m, n: string) => env[n] ?? "");
  }
  return expandHome(out);
}

export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** Returns true when `child` is `root` itself or strictly inside it (both absolute & normalized). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
