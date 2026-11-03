// Host-side MCP (Streamable HTTP, JSON responses only) bridge that exposes the selected tracker
// adapter's provider-native tools to Claude Code sessions (SPEC §10.5 optional extension).
//
// - Bound to loopback on an ephemeral port.
// - Each agent session gets its own random bearer token; the token maps to a frozen snapshot of
//   {adapter, tool specs, issue context}. The tracker credential itself never leaves this process.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../log.ts";
import type { Issue, ToolResult, ToolSpec, TrackerAdapter } from "../types.ts";
import { isPlainObject, truncate } from "../util.ts";

export const MCP_SERVER_NAME = "symphony";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface BridgeSession {
  token: string;
  adapter: TrackerAdapter;
  specs: ToolSpec[];
  workspacePath: string;
  getIssue: () => Issue;
  onToolEvent?: (ev: { name: string; ok: boolean; supported: boolean; error?: string }) => void;
}

export class ToolBridge {
  private server: http.Server | null = null;
  private port = 0;
  private sessions = new Map<string, BridgeSession>();
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log.child({ component: "tool_bridge" });
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error("tool bridge request failed", { error: err });
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.log.info("tool bridge listening", { url: this.url() });
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  register(s: Omit<BridgeSession, "token">): BridgeSession {
    const token = crypto.randomBytes(24).toString("hex");
    const session = { ...s, token };
    this.sessions.set(token, session);
    return session;
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  /** `--mcp-config` JSON for a registered session. */
  mcpConfigJson(session: BridgeSession): string {
    return JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url: this.url(), headers: { Authorization: `Bearer ${session.token}` } },
      },
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const session = this.sessions.get(token);
    if (!session) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET") {
      // No server-initiated SSE stream.
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    const raw = await readBody(req, 4 * 1024 * 1024);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const responses: unknown[] = [];
    for (const m of batch) {
      const r = await this.dispatch(session, m);
      if (r !== null) responses.push(r);
    }
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(msg) ? responses : responses[0]));
  }

  private async dispatch(session: BridgeSession, m: unknown): Promise<unknown | null> {
    if (!isPlainObject(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      if (isPlainObject(m) && "id" in m && !("method" in m)) return null; // a response to us; ignore
      return { jsonrpc: "2.0", id: isPlainObject(m) ? (m.id ?? null) : null, error: { code: -32600, message: "invalid request" } };
    }
    const id = m.id;
    const isNotification = id === undefined;
    const params = isPlainObject(m.params) ? m.params : {};
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    switch (m.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : SUPPORTED_PROTOCOLS[0];
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "claude-symphony", version: "0.1.0" },
          instructions: "Provider-native issue tracker tools executed by Symphony with host-side credentials.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: session.specs.map((s) => ({
            name: s.name,
            description: s.description,
            inputSchema: s.inputSchema,
            annotations: { readOnlyHint: !s.mutates, destructiveHint: false, openWorldHint: true },
          })),
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = isPlainObject(params.arguments) ? params.arguments : {};
        const supported = session.specs.some((s) => s.name === name);
        let result: ToolResult;
        if (!supported || !session.adapter.executeAgentTool) {
          result = { ok: false, error: { code: "unsupported_tool", message: `unsupported tool: ${name}` } };
        } else {
          try {
            result = await session.adapter.executeAgentTool(name, args, {
              issue: session.getIssue(),
              workspacePath: session.workspacePath,
            });
          } catch (err) {
            result = { ok: false, error: { code: "tool_error", message: (err as Error).message } };
          }
        }
        session.onToolEvent?.({
          name,
          ok: result.ok,
          supported,
          error: result.ok ? undefined : `${result.error.code}: ${truncate(result.error.message, 300)}`,
        });
        const payload = result.ok ? { ok: true, result: result.output } : { ok: false, error: result.error };
        return ok({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
          isError: !result.ok,
        });
      }
      default:
        if (m.method.startsWith("notifications/")) return null;
        return isNotification ? null : { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
