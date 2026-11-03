// Tracker adapter registry. Adapters are constructed from the current effective config snapshot.
import type { ServiceConfig } from "../config.ts";
import { TrackerError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { TrackerAdapter } from "../types.ts";
import { GITHUB_DEFAULT_ACTIVE_STATES, GITHUB_DEFAULT_TERMINAL_STATES, GitHubAdapter, parseGitHubProvider } from "./github.ts";

export interface BuiltTracker {
  adapter: TrackerAdapter;
  activeStates: string[];
  terminalStates: string[];
}

export type TrackerFactory = (cfg: ServiceConfig, log: Logger, env: NodeJS.ProcessEnv) => BuiltTracker;

const factories = new Map<string, TrackerFactory>();

export function registerTracker(kind: string, factory: TrackerFactory): void {
  factories.set(kind.toLowerCase(), factory);
}

export function supportedTrackerKinds(): string[] {
  return [...factories.keys()];
}

registerTracker("github", (cfg, log, env) => {
  const provider = parseGitHubProvider(cfg.tracker.provider, env);
  const activeStates = cfg.tracker.active_states ?? GITHUB_DEFAULT_ACTIVE_STATES;
  const terminalStates = cfg.tracker.terminal_states ?? GITHUB_DEFAULT_TERMINAL_STATES;
  return {
    adapter: new GitHubAdapter({ provider, activeStates, terminalStates, log }),
    activeStates,
    terminalStates,
  };
});

/** Build the configured adapter. Throws TrackerError for unsupported kind / invalid provider config. */
export function buildTracker(cfg: ServiceConfig, log: Logger, env: NodeJS.ProcessEnv = process.env): BuiltTracker {
  const kind = (cfg.tracker.kind ?? "").toLowerCase();
  const f = factories.get(kind);
  if (!f) {
    throw new TrackerError(
      "unsupported_tracker_kind",
      `unsupported tracker.kind '${cfg.tracker.kind ?? ""}' (supported: ${supportedTrackerKinds().join(", ")})`,
    );
  }
  const built = f(cfg, log, env);
  if (built.activeStates.length === 0) throw new TrackerError("invalid_tracker_config", "tracker.active_states is empty");
  return built;
}
