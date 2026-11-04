// Workflow Loader (SPEC §5) + change watcher (SPEC §6.2).
//
// Two on-disk formats produce the same WorkflowDefinition:
// - `symphony.yml` (default; any `.yml` / `.yaml` / `.json` path): the whole file is the config map; the prompt is
//   the `prompt:` string or the file named by `prompt_file:` (relative to the config file).
// - `WORKFLOW.md` (Symphony spec format): YAML front matter + Markdown prompt body.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { SymphonyError } from "./errors.ts";
import type { WorkflowDefinition } from "./types.ts";
import { isPlainObject, resolvePathValue } from "./util.ts";

/** Default config file name (no lookup of alternatives). */
export const DEFAULT_CONFIG_FILE = "symphony.yml";

/** Config path: explicit runtime setting, else `./symphony.yml` in cwd. */
export function resolveWorkflowPath(explicit?: string | null, cwd: string = process.cwd()): string {
  return path.resolve(cwd, explicit && explicit.length > 0 ? explicit : DEFAULT_CONFIG_FILE);
}

export function isStructuredConfigPath(filePath: string): boolean {
  return /\.(ya?ml|json)$/i.test(filePath);
}

/**
 * Parse a `symphony.yml`-style file. `prompt` / `prompt_file` are removed from the returned
 * config. `readFile` is injectable for tests.
 */
export function parseConfigFile(
  text: string,
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): WorkflowDefinition {
  const src = text.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = YAML.parse(src, { prettyErrors: true, strict: true, uniqueKeys: true });
  } catch (err) {
    throw new SymphonyError("workflow_parse_error", `invalid config file ${filePath}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isPlainObject(parsed)) throw new SymphonyError("workflow_front_matter_not_a_map", "config file must decode to a map/object");
  const { prompt, prompt_file: promptFile, ...config } = parsed;
  if (prompt !== undefined && prompt !== null && promptFile !== undefined && promptFile !== null) {
    throw new SymphonyError("workflow_parse_error", "set either prompt or prompt_file, not both");
  }
  const sources = [path.resolve(filePath)];
  let template = "";
  if (promptFile !== undefined && promptFile !== null) {
    if (typeof promptFile !== "string" || !promptFile.trim()) {
      throw new SymphonyError("workflow_parse_error", "prompt_file must be a non-empty string");
    }
    const p = path.resolve(path.dirname(path.resolve(filePath)), resolvePathValue(promptFile, env));
    try {
      template = readFile(p);
    } catch (err) {
      throw new SymphonyError("workflow_parse_error", `cannot read prompt_file ${p}: ${(err as Error).message}`);
    }
    sources.push(p);
  } else if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== "string") throw new SymphonyError("workflow_parse_error", "prompt must be a string");
    template = prompt;
  }
  return { config, prompt_template: template.replace(/\r\n?/g, "\n").trim(), source_files: sources };
}

export function parseWorkflow(text: string): WorkflowDefinition {
  // Normalize line endings & strip BOM.
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  let config: Record<string, unknown> = {};
  let body: string;

  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end === -1) {
      throw new SymphonyError("workflow_parse_error", "front matter starts with '---' but has no closing '---'");
    }
    const yamlText = lines.slice(1, end).join("\n");
    let parsed: unknown;
    try {
      parsed = YAML.parse(yamlText, { prettyErrors: true, strict: true, uniqueKeys: true });
    } catch (err) {
      throw new SymphonyError("workflow_parse_error", `invalid YAML front matter: ${(err as Error).message}`);
    }
    if (parsed === null || parsed === undefined) {
      config = {};
    } else if (!isPlainObject(parsed)) {
      throw new SymphonyError("workflow_front_matter_not_a_map", "YAML front matter must decode to a map/object");
    } else {
      config = parsed;
    }
    body = lines.slice(end + 1).join("\n");
  } else {
    body = src;
  }

  return { config, prompt_template: body.trim() };
}

export function loadWorkflow(filePath: string, env: NodeJS.ProcessEnv = process.env): WorkflowDefinition {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new SymphonyError("missing_workflow_file", `cannot read workflow file ${filePath}: ${(err as Error).message}`);
  }
  if (isStructuredConfigPath(filePath)) return parseConfigFile(text, filePath, env);
  return { ...parseWorkflow(text), source_files: [path.resolve(filePath)] };
}

/** Cheap fingerprint used for defensive re-validation when watch events are missed. */
export function workflowFingerprint(filePath: string | string[]): string | null {
  const files = Array.isArray(filePath) ? filePath : [filePath];
  return files
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}:${st.ino}`;
      } catch {
        return "missing";
      }
    })
    .join("|");
}

/**
 * Watches the workflow file. Watches the containing directory (robust to editors that replace the
 * file via rename) and also polls the fingerprint as a fallback.
 */
export class WorkflowWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private files: string[];
  private last: string | null;
  private readonly onChange: () => void;

  constructor(filePath: string, onChange: () => void, pollMs = 2000) {
    this.onChange = onChange;
    this.files = [path.resolve(filePath)];
    this.last = workflowFingerprint(this.files);
    this.syncWatchers();
    this.pollTimer = setInterval(() => this.check(), pollMs);
    this.pollTimer.unref();
  }

  /** Replace the watched file set (e.g. config + prompt_file after a reload). */
  setFiles(files: string[]): void {
    const next = [...new Set(files.map((f) => path.resolve(f)))];
    if (next.length === 0) return;
    this.files = next;
    this.syncWatchers();
    this.markSeen();
  }

  private syncWatchers(): void {
    const dirs = new Set(this.files.map((f) => path.dirname(f)));
    for (const [d, w] of this.watchers) {
      if (!dirs.has(d)) {
        w.close();
        this.watchers.delete(d);
      }
    }
    for (const d of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const w = fs.watch(d, { persistent: false }, (_ev, name) => {
          if (name === null || this.files.some((f) => path.dirname(f) === d && path.basename(f) === name.toString())) this.check();
        });
        w.on("error", () => {
          /* fall back to polling */
        });
        this.watchers.set(d, w);
      } catch {
        /* polling only */
      }
    }
  }

  private check(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const fp = workflowFingerprint(this.files);
      if (fp !== this.last) {
        this.last = fp;
        this.onChange();
      }
    }, 100);
    this.debounce.unref();
  }

  /** Force the stored fingerprint (used after an explicit reload). */
  markSeen(): void {
    this.last = workflowFingerprint(this.files);
  }

  hasChanged(): boolean {
    return workflowFingerprint(this.files) !== this.last;
  }

  close(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
  }
}
