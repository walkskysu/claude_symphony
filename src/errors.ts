// Typed error surface. Every error carries a stable `category` plus a human-readable message
// (SPEC §5.5, §10.6, §11.4).

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error";

export type ConfigErrorCode =
  | "invalid_config"
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "missing_agent_command";

export type TrackerErrorCode =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export type AgentErrorCode =
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "stalled"
  | "canceled_by_reconciliation";

export type WorkspaceErrorCode = "workspace_error" | "workspace_outside_root" | "hook_failed" | "hook_timeout";

export type ErrorCategory = WorkflowErrorCode | ConfigErrorCode | TrackerErrorCode | AgentErrorCode | WorkspaceErrorCode;

export class SymphonyError extends Error {
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;
  constructor(category: ErrorCategory, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SymphonyError";
    this.category = category;
    this.details = details;
  }
  override toString(): string {
    return `${this.category}: ${this.message}`;
  }
}

export class TrackerError extends SymphonyError {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly status: number | null;
  constructor(
    category: TrackerErrorCode,
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number | null; status?: number | null } = {},
  ) {
    super(category, message);
    this.name = "TrackerError";
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.status = opts.status ?? null;
  }
}

export function errorSummary(err: unknown): string {
  if (err instanceof SymphonyError) return `${err.category}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
