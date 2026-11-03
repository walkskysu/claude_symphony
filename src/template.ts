// Strict prompt rendering (SPEC §5.4, §12). Liquid with strict variables + strict filters.
import { Liquid } from "liquidjs";
import { SymphonyError } from "./errors.ts";
import type { Issue } from "./types.ts";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  cache: false,
});

export const DEFAULT_PROMPT = "You are working on an issue from the configured tracker.";

export interface RenderInput {
  issue: Issue;
  attempt: number | null;
  [extra: string]: unknown;
}

function toTemplateValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toTemplateValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[String(k)] = toTemplateValue(val);
    return out;
  }
  return v;
}

export function renderPrompt(template: string, input: RenderInput): string {
  const src = template.trim() === "" ? DEFAULT_PROMPT : template;
  let parsed;
  try {
    parsed = engine.parse(src);
  } catch (err) {
    throw new SymphonyError("template_parse_error", (err as Error).message);
  }
  const scope: Record<string, unknown> = { ...(toTemplateValue(input) as Record<string, unknown>) };
  // `attempt` is always defined in scope (null on first run) so templates can test it.
  scope.attempt = input.attempt ?? null;
  try {
    return engine.renderSync(parsed, scope) as string;
  } catch (err) {
    throw new SymphonyError("template_render_error", (err as Error).message);
  }
}

export function continuationPrompt(issue: Issue, turn: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    `The issue is still in tracker state "${issue.state}" (continuation turn ${turn} of at most ${maxTurns} in this session).`,
    "Pick up where you left off. If the work is complete, move the issue to the workflow's handoff state using the",
    "available tracker tools; if you are blocked, explain why in an issue comment and move it to the appropriate state.",
  ].join("\n");
}
