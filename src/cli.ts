#!/usr/bin/env node
// CLI host lifecycle (SPEC §17.7).
//   claude-symphony [config] [--port N] [--host H] [--log-file F] [--log-level L]
//   claude-symphony check [config]    # validate config + tracker connectivity + labels, then exit
//   claude-symphony labels [config]   # create missing tracker labels (GitHub), then exit
import fs from "node:fs";
import { parseArgs } from "node:util";
import { buildConfig, validateCoreConfig } from "./config.ts";
import { errorSummary } from "./errors.ts";
import { startHttpServer } from "./http.ts";
import { rootLogger, type Level } from "./log.ts";
import { Orchestrator } from "./orchestrator.ts";
import { buildTracker } from "./tracker/index.ts";
import { loadWorkflow, resolveWorkflowPath } from "./workflow.ts";

const USAGE = `Usage: claude-symphony [check|labels] [config-file] [options]

  config-file        Default ./symphony.yml. An explicit path may also be .yaml/.json or a
                     Symphony-spec WORKFLOW.md.
  check              Validate config, list candidate issues, report missing labels
  labels             Create missing workflow labels in every configured repository

Options:
  --port <n>         Start the HTTP dashboard/API (overrides server.port; 0 = ephemeral)
  --host <addr>      HTTP bind address (default 127.0.0.1)
  --log-file <path>  Also append structured logs to this file
  --log-level <lvl>  debug | info | warn | error (default info)
  -h, --help         Show this help
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "log-file": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let mode: "run" | "check" | "labels" = "run";
  const pos = [...positionals];
  if (pos[0] === "check" || pos[0] === "labels") {
    mode = pos[0];
    pos.shift();
  }
  if (pos.length > 1) {
    process.stderr.write(`too many arguments\n\n${USAGE}`);
    return 2;
  }
  const log = rootLogger;
  if (values["log-level"]) log.setLevel(values["log-level"] as Level);
  if (values["log-file"]) log.setFile(values["log-file"]);

  const workflowPath = resolveWorkflowPath(pos[0]);
  if (!fs.existsSync(workflowPath)) {
    log.error("workflow file not found", { path: workflowPath, error: "missing_workflow_file" });
    return 1;
  }

  if (mode === "labels") {
    try {
      const cfg = buildConfig(loadWorkflow(workflowPath), workflowPath);
      validateCoreConfig(cfg);
      const t = buildTracker(cfg, log);
      if (!t.adapter.prepare) {
        log.info("tracker has no label setup", { tracker_kind: cfg.tracker.kind });
        return 0;
      }
      const lines = await t.adapter.prepare("apply");
      for (const l of lines) process.stdout.write(`${l}\n`);
      return lines.some((l) => l.includes("failed")) ? 1 : 0;
    } catch (err) {
      log.error("labels failed", { error: errorSummary(err) });
      return 1;
    }
  }

  if (mode === "check") {
    try {
      const wf = loadWorkflow(workflowPath);
      const cfg = buildConfig(wf, workflowPath);
      validateCoreConfig(cfg);
      const t = buildTracker(cfg, log);
      const issues = await t.adapter.fetchIssuesByStates(t.activeStates);
      log.info("check ok", {
        tracker_kind: cfg.tracker.kind,
        active_states: t.activeStates.join(","),
        candidates: issues.length,
        dispatchable: issues.filter((i) => i.dispatchable).length,
        workspace_root: cfg.workspace.root,
      });
      for (const i of issues) process.stdout.write(`${i.identifier}\t${i.state}\t${i.dispatchable ? "dispatchable" : "blocked"}\t${i.title}\n`);
      if (t.adapter.prepare) {
        for (const l of await t.adapter.prepare("check")) process.stdout.write(`labels\t${l}\n`);
      }
      return 0;
    } catch (err) {
      log.error("check failed", { error: errorSummary(err) });
      return 1;
    }
  }

  const orch = new Orchestrator({ workflowPath, log });
  try {
    await orch.start();
  } catch (err) {
    log.error("startup failed", { error: errorSummary(err) });
    return 1;
  }

  let http: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  const cfg = orch.cfg();
  const port = values.port !== undefined ? Number(values.port) : cfg.server.port;
  if (port !== null && port !== undefined) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      log.error("invalid --port", { port: values.port });
      await orch.stop();
      return 2;
    }
    try {
      http = await startHttpServer(orch, { port, host: values.host ?? cfg.server.host, log });
    } catch (err) {
      // Observability failures never take the orchestrator down.
      log.error("http server failed to start; continuing without it", { error: errorSummary(err) });
    }
  }

  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (sig: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutdown requested", { signal: sig });
      await http?.close().catch(() => undefined);
      await orch.stop();
      resolve(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("uncaughtException", (err) => {
      log.error("uncaught exception", { error: err, stack: err.stack });
      void orch.stop().finally(() => resolve(1));
    });
    process.on("unhandledRejection", (err) => {
      log.error("unhandled rejection", { error: errorSummary(err) });
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    rootLogger.error("fatal", { error: errorSummary(err) });
    process.exit(1);
  },
);
