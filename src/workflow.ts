// Workflow Loader (SPEC §5) + change watcher (SPEC §6.2).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { SymphonyError } from "./errors.ts";
import type { WorkflowDefinition } from "./types.ts";
import { isPlainObject } from "./util.ts";

/** Workflow path precedence: explicit runtime setting, else ./WORKFLOW.md in cwd (SPEC §5.1). */
export function resolveWorkflowPath(explicit?: string | null, cwd: string = process.cwd()): string {
  return path.resolve(cwd, explicit && explicit.length > 0 ? explicit : "WORKFLOW.md");
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

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new SymphonyError("missing_workflow_file", `cannot read workflow file ${filePath}: ${(err as Error).message}`);
  }
  return parseWorkflow(text);
}

/** Cheap fingerprint used for defensive re-validation when watch events are missed. */
export function workflowFingerprint(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * Watches the workflow file. Watches the containing directory (robust to editors that replace the
 * file via rename) and also polls the fingerprint as a fallback.
 */
export class WorkflowWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private last: string | null;
  private readonly filePath: string;
  private readonly onChange: () => void;

  constructor(filePath: string, onChange: () => void, pollMs = 2000) {
    this.filePath = filePath;
    this.onChange = onChange;
    this.last = workflowFingerprint(filePath);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (name === null || name.toString() === base) this.check();
      });
      this.watcher.on("error", () => {
        /* fall back to polling */
      });
    } catch {
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => this.check(), pollMs);
    this.pollTimer.unref();
  }

  private check(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const fp = workflowFingerprint(this.filePath);
      if (fp !== this.last) {
        this.last = fp;
        this.onChange();
      }
    }, 100);
    this.debounce.unref();
  }

  /** Force the stored fingerprint (used after an explicit reload). */
  markSeen(): void {
    this.last = workflowFingerprint(this.filePath);
  }

  hasChanged(): boolean {
    return workflowFingerprint(this.filePath) !== this.last;
  }

  close(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
  }
}
