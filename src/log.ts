// Structured key=value logger (SPEC §13.1/§13.2).
// Sinks: stderr (always) and an optional append-only file. Sink failures never crash the service.
import fs from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

export interface LogRecord {
  ts: string;
  level: Level;
  msg: string;
  fields: Fields;
}

type Listener = (rec: LogRecord) => void;

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  let s: string;
  if (typeof v === "string") s = v;
  else if (v instanceof Error) s = v.message;
  else if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else s = String(v);
  if (s.length > 2000) s = s.slice(0, 2000) + "…";
  return /[\s"=]/.test(s) || s === "" ? JSON.stringify(s) : s;
}

export function formatRecord(rec: LogRecord): string {
  const parts = [`ts=${rec.ts}`, `level=${rec.level}`, `msg=${fmtValue(rec.msg)}`];
  for (const [k, v] of Object.entries(rec.fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${fmtValue(v)}`);
  }
  return parts.join(" ");
}

export class Logger {
  private minLevel: Level;
  private filePath: string | null = null;
  private fileFailed = false;
  private listeners = new Set<Listener>();
  private base: Fields;
  private root: Logger | null;
  private stderrEnabled = true;

  constructor(opts: { level?: Level; base?: Fields; root?: Logger } = {}) {
    this.minLevel = opts.level ?? "info";
    this.base = opts.base ?? {};
    this.root = opts.root ?? null;
  }

  child(fields: Fields): Logger {
    return new Logger({ level: this.minLevel, base: { ...this.base, ...fields }, root: this.root ?? this });
  }

  setLevel(level: Level): void {
    (this.root ?? this).minLevel = level;
  }

  setFile(path: string | null): void {
    const r = this.root ?? this;
    r.filePath = path;
    r.fileFailed = false;
  }

  setStderr(enabled: boolean): void {
    (this.root ?? this).stderrEnabled = enabled;
  }

  onRecord(l: Listener): () => void {
    const r = this.root ?? this;
    r.listeners.add(l);
    return () => r.listeners.delete(l);
  }

  debug(msg: string, fields: Fields = {}): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields: Fields = {}): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields: Fields = {}): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields: Fields = {}): void {
    this.emit("error", msg, fields);
  }

  private emit(level: Level, msg: string, fields: Fields): void {
    const r = this.root ?? this;
    if (ORDER[level] < ORDER[r.minLevel]) return;
    const rec: LogRecord = { ts: new Date().toISOString(), level, msg, fields: { ...this.base, ...fields } };
    const line = formatRecord(rec) + "\n";
    if (r.stderrEnabled) {
      try {
        process.stderr.write(line);
      } catch {
        /* stderr unavailable; keep going */
      }
    }
    if (r.filePath && !r.fileFailed) {
      try {
        fs.appendFileSync(r.filePath, line);
      } catch (err) {
        r.fileFailed = true;
        try {
          process.stderr.write(
            formatRecord({
              ts: rec.ts,
              level: "warn",
              msg: "log file sink failed; continuing with remaining sinks",
              fields: { path: r.filePath, error: err },
            }) + "\n",
          );
        } catch {
          /* ignore */
        }
      }
    }
    for (const l of r.listeners) {
      try {
        l(rec);
      } catch {
        /* listener failures never break logging */
      }
    }
  }
}

export const rootLogger = new Logger({ level: (process.env.SYMPHONY_LOG_LEVEL as Level) || "info" });
