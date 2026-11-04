// Core domain model (SPEC §4.1).

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: string | null; // RFC 3339
  updated_at: string | null; // RFC 3339
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
  /** Files the definition was read from (config + optional prompt file); watched for reload. */
  source_files?: string[];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Event emitted by the agent client up to the orchestrator (SPEC §10.4). */
export interface AgentEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: string | null;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  /** Absolute thread token totals, when the event carries them. */
  usage?: TokenUsage;
  rate_limits?: unknown;
  message?: string;
  cost_usd?: number;
  payload?: unknown;
}

// ---- Provider-native agent tools (SPEC §10.5 optional extension) -------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether the tool can mutate tracker state (documentation + annotations). */
  mutates: boolean;
}

/** Image returned to the model alongside a tool's JSON output (MCP `image` content). */
export interface ToolImage {
  mimeType: string;
  /** base64 */
  data: string;
}

export type ToolResult =
  | { ok: true; output: unknown; images?: ToolImage[] }
  | { ok: false; error: { code: string; message: string } };

export interface ToolContext {
  issue: Issue;
  workspacePath: string;
}

// ---- Tracker adapter contract (SPEC §11) -------------------------------------------------------

export interface TrackerAdapter {
  readonly kind: string;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;
  agentToolSpecs?(): ToolSpec[];
  secretEnvironmentNames?(): string[];
  /**
   * Optional tracker-side setup (e.g. GitHub labels). `check` only reports, `startup` applies what
   * the config enables, `apply` applies unconditionally. Returns human-readable report lines.
   */
  prepare?(mode: "check" | "startup" | "apply"): Promise<string[]>;
  /** Extra `SYMPHONY_*` env for hooks and the agent process (e.g. the issue's repository). */
  issueEnvironment?(issue: Issue): Record<string, string>;
  executeAgentTool?(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
