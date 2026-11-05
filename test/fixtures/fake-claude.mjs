#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Behaviour is controlled by env:
//   FAKE_MODE=ok|fail|hang|exit|silent_after_init   (default ok)
//   FAKE_TOOL=<tool name>   call this MCP tool through --mcp-config on the first turn
//   FAKE_TOOL_ARGS=<json>
//   FAKE_RECORD=<file>      append received argv/env/messages as JSON lines
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = arg("--session-id") ?? "no-session";
const mode = process.env.FAKE_MODE ?? "ok";
const record = (o) => {
  if (process.env.FAKE_RECORD) fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(o) + "\n");
};
record({ kind: "start", argv, cwd: process.cwd(), env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null, SYMPHONY_ISSUE_IDENTIFIER: process.env.SYMPHONY_ISSUE_IDENTIFIER, SYMPHONY_ISSUE_REPO: process.env.SYMPHONY_ISSUE_REPO ?? null } });
process.stderr.write("fake-claude diagnostics on stderr\n");

if (mode === "exit") process.exit(3);

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let turns = 0;
let initialized = false;

async function callTool() {
  const cfg = JSON.parse(arg("--mcp-config"));
  const srv = cfg.mcpServers.symphony;
  const post = async (body) => {
    const r = await fetch(srv.url, { method: "POST", headers: { ...srv.headers, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    return r.status === 202 ? null : r.json();
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: process.env.FAKE_TOOL, arguments: JSON.parse(process.env.FAKE_TOOL_ARGS ?? "{}") } });
  record({ kind: "tool", list, res });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ kind: "stdin", msg });
  if (msg.type !== "user") return;
  turns++;
  if (!initialized) {
    initialized = true;
    out({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", tools: ["Bash"], mcp_servers: [] });
  }
  if (mode === "silent_after_init" || mode === "hang") return;
  if (process.env.FAKE_TOOL && turns === 1) await callTool();
  // One API response split into two events with the same id (as Claude Code streams it).
  const msgUsage = (out_) => ({ input_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: out_ });
  out({ type: "assistant", session_id: sessionId, message: { id: `msg_${turns}`, usage: msgUsage(5), content: [{ type: "text", text: `working turn ${turns}` }] } });
  out({ type: "assistant", session_id: sessionId, message: { id: `msg_${turns}`, usage: msgUsage(10), content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 123 } });
  out({
    type: "result",
    subtype: mode === "fail" ? "error_during_execution" : "success",
    is_error: mode === "fail",
    session_id: sessionId,
    num_turns: 2,
    result: `done turn ${turns}`,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 },
  });
});
rl.on("close", () => process.exit(0));
