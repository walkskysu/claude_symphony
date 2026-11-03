// github_issue_attachments: extraction, host allow-list, download limits, safe writes, MCP image content.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ToolBridge } from "../src/agent/tool-bridge.ts";
import {
  downloadImage,
  ensureAttachmentsDir,
  extractImageRefs,
  isAllowedImageUrl,
  sniffImage,
} from "../src/tracker/github-attachments.ts";
import { GitHubAdapter, parseGitHubProvider } from "../src/tracker/github.ts";
import type { TrackerAdapter } from "../src/types.ts";
import { mkIssue, quietLogger, tmpDir } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPG = Buffer.from("ffd8ffe000104a464946", "hex");
const WEB = "https://github.com";

type Handler = (url: URL, init: RequestInit) => Response | undefined;
function fetchMock(h: Handler) {
  const calls: { url: string; auth: string | null; accept: string | null }[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: url.toString(), auth: headers.Authorization ?? null, accept: headers.Accept ?? null });
    return h(url, init) ?? new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const bin = (b: Buffer, type = "image/png") => new Response(b, { status: 200, headers: { "content-type": type } });

describe("attachment helpers", () => {
  it("extracts from rendered html first (decoding entities), markdown as fallback", () => {
    const html = '<p><a href="x"><img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=A&amp;b=1" alt="shot" data-canonical-src="https://github.com/user-attachments/assets/u1"></a></p>';
    assert.deepEqual(extractImageRefs("![ignored](https://github.com/user-attachments/assets/u1)", html), [
      { url: "https://private-user-images.githubusercontent.com/1/a.png?jwt=A&b=1", alt: "shot" },
    ]);
    const md = '![a](https://github.com/user-attachments/assets/u1) ![](<https://x.githubusercontent.com/b.jpg> "t")\n<img src="https://github.com/user-attachments/assets/u1"> ![rel](./local.png)';
    assert.deepEqual(extractImageRefs(md, null), [
      { url: "https://github.com/user-attachments/assets/u1", alt: "a" },
      { url: "https://x.githubusercontent.com/b.jpg", alt: null },
    ]);
  });

  it("allows only GitHub hosts", () => {
    assert.equal(isAllowedImageUrl("https://github.com/user-attachments/assets/abc", WEB), true);
    assert.equal(isAllowedImageUrl("https://github.com/o/r/assets/1/abc", WEB), true);
    assert.equal(isAllowedImageUrl("https://private-user-images.githubusercontent.com/x.png", WEB), true);
    assert.equal(isAllowedImageUrl("https://camo.githubusercontent.com/abc", WEB), true);
    assert.equal(isAllowedImageUrl("https://github.com/login", WEB), false);
    assert.equal(isAllowedImageUrl("http://user-images.githubusercontent.com/x.png", WEB), false);
    assert.equal(isAllowedImageUrl("https://evilgithubusercontent.com/x.png", WEB), false);
    assert.equal(isAllowedImageUrl("https://169.254.169.254/latest", WEB), false);
    assert.equal(isAllowedImageUrl("https://u:p@github.com/user-attachments/assets/x", WEB), false);
    assert.equal(isAllowedImageUrl("https://ghe.corp/storage/x.png", "https://ghe.corp"), true);
    assert.equal(isAllowedImageUrl("https://media.ghe.corp/x.png", "https://ghe.corp"), true);
    assert.equal(isAllowedImageUrl("https://other.corp/x.png", "https://ghe.corp"), false);
  });

  it("sniffs image types by magic bytes", () => {
    assert.equal(sniffImage(PNG)?.mime, "image/png");
    assert.equal(sniffImage(JPG)?.mime, "image/jpeg");
    assert.equal(sniffImage(Buffer.from("GIF89a....."))?.mime, "image/gif");
    assert.equal(sniffImage(Buffer.from("RIFF....WEBPVP8 "))?.mime, "image/webp");
    assert.equal(sniffImage(Buffer.from("<svg xmlns=...>"))?.inlinable, false);
    assert.equal(sniffImage(Buffer.from("<!doctype html><html>")), null);
  });
});

describe("downloadImage", () => {
  const opts = { webUrl: WEB, token: "tok", maxBytes: 1000, timeoutMs: 5000 };

  it("follows allowed redirects and sends the token only to the web host", async () => {
    const m = fetchMock((u) => {
      if (u.hostname === "github.com") return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/img?sig=1" } });
      if (u.hostname === "objects.githubusercontent.com") return bin(PNG);
      return undefined;
    });
    const r = await downloadImage(m.fn, "https://github.com/user-attachments/assets/abc", opts);
    assert.equal(r.kind.mime, "image/png");
    assert.deepEqual(m.calls.map((c) => c.auth), ["Bearer tok", null]);
  });

  it("rejects redirects off GitHub, oversized and non-image payloads", async () => {
    const evil = fetchMock(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } }));
    await assert.rejects(downloadImage(evil.fn, "https://github.com/user-attachments/assets/a", opts), { code: "forbidden_url" });
    assert.equal(evil.calls.length, 1);
    const big = fetchMock(() => bin(Buffer.concat([PNG, Buffer.alloc(2000)])));
    await assert.rejects(downloadImage(big.fn, "https://x.githubusercontent.com/a.png", opts), { code: "too_large" });
    const html = fetchMock(() => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await assert.rejects(downloadImage(html.fn, "https://github.com/user-attachments/assets/a", opts), { code: "not_an_image" });
    await assert.rejects(downloadImage(html.fn, "https://example.com/a.png", opts), { code: "forbidden_url" });
  });
});

describe("attachments dir", () => {
  it("creates a git-ignored dir and refuses a symlinked .symphony", () => {
    const ws = tmpDir();
    const dir = ensureAttachmentsDir(ws);
    assert.equal(dir, path.join(fs.realpathSync(ws), ".symphony", "attachments"));
    assert.equal(fs.readFileSync(path.join(ws, ".symphony", ".gitignore"), "utf8"), "*\n");

    const ws2 = tmpDir();
    const outside = tmpDir();
    fs.symlinkSync(outside, path.join(ws2, ".symphony"));
    assert.throws(() => ensureAttachmentsDir(ws2), { code: "unsafe_path" });
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

describe("github_issue_attachments tool", () => {
  it("downloads body + comment images, saves files, returns inline images, reports failures", async () => {
    const ws = tmpDir();
    const m = fetchMock((u) => {
      if (u.pathname === "/repos/o/r/issues/7") {
        return json({
          number: 7,
          title: "t",
          state: "open",
          user: { login: "alice" },
          body: "![shot](https://github.com/user-attachments/assets/u1)",
          body_html: '<img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=SECRET" alt="shot">',
        });
      }
      if (u.pathname === "/repos/o/r/issues/7/comments") {
        return json([
          { id: 55, user: { login: "bob" }, body: "![j](https://x.githubusercontent.com/b.jpg) ![bad](https://evil.example/c.png)" },
          { id: 56, user: { login: "carol" }, body: "no images" },
        ]);
      }
      if (u.hostname === "private-user-images.githubusercontent.com") return bin(PNG);
      if (u.hostname === "x.githubusercontent.com") return bin(JPG, "image/jpeg");
      return undefined;
    });
    const a = new GitHubAdapter({
      provider: parseGitHubProvider({ repository: "o/r", token: "tok" }, {}),
      activeStates: ["Todo"],
      terminalStates: ["Closed"],
      log: quietLogger(),
      fetchFn: m.fn,
    });
    const issue = mkIssue({ id: "o/r#7", native_ref: { owner: "o", repo: "r", number: 7 } });
    const r = await a.executeAgentTool("github_issue_attachments", {}, { issue, workspacePath: ws });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const out = r.output as { images: Record<string, unknown>[]; total_found: number; downloaded: number };
    assert.equal(out.total_found, 3);
    assert.equal(out.downloaded, 2);
    assert.deepEqual(out.images.map((i) => i.path ?? null), [
      path.join(".symphony", "attachments", "issue-1.png"),
      path.join(".symphony", "attachments", "comment-55-1.jpg"),
      null,
    ]);
    assert.equal((out.images[2].error as { code: string }).code, "forbidden_url");
    assert.equal(out.images[0].url, "https://private-user-images.githubusercontent.com/1/a.png"); // signed query stripped
    assert.equal(JSON.stringify(out).includes("SECRET"), false);
    assert.deepEqual(r.images?.map((i) => i.mimeType), ["image/png", "image/jpeg"]);
    assert.deepEqual(fs.readFileSync(path.join(ws, ".symphony", "attachments", "issue-1.png")), PNG);
    assert.ok(m.calls.filter((c) => c.url.includes("/repos/")).every((c) => c.accept === "application/vnd.github.full+json"));
    assert.ok(!m.calls.some((c) => c.url.includes("evil.example")));

    // comment filter + inline=false
    const r2 = await a.executeAgentTool("github_issue_attachments", { comment_ids: [55], inline: false }, { issue, workspacePath: ws });
    assert.equal(r2.ok && r2.images?.length, 0);
    assert.equal(r2.ok && (r2.output as { total_found: number }).total_found, 2);
  });
});

describe("tool bridge image content", () => {
  it("returns MCP image blocks after the JSON text block", async () => {
    const bridge = new ToolBridge(quietLogger());
    await bridge.start();
    try {
      const adapter: TrackerAdapter = {
        kind: "x",
        fetchIssuesByStates: async () => [],
        fetchIssuesByIds: async () => [],
        executeAgentTool: async () => ({ ok: true, output: { n: 1 }, images: [{ mimeType: "image/png", data: PNG.toString("base64") }] }),
      };
      const s = bridge.register({
        adapter,
        specs: [{ name: "pic", description: "", inputSchema: { type: "object" }, mutates: false }],
        workspacePath: "/tmp",
        getIssue: () => mkIssue({}),
      });
      const res = await fetch(bridge.url(), {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pic", arguments: {} } }),
      });
      const body = (await res.json()) as { result: { content: { type: string; mimeType?: string; data?: string }[]; isError: boolean } };
      assert.equal(body.result.isError, false);
      assert.deepEqual(body.result.content.map((c) => c.type), ["text", "image"]);
      assert.equal(body.result.content[1].mimeType, "image/png");
      assert.equal(body.result.content[1].data, PNG.toString("base64"));
    } finally {
      await bridge.stop();
    }
  });
});
