// Host-side download of images referenced from GitHub issue bodies / comments, for the
// `github_issue_attachments` agent tool.
//
// Security posture:
// - Only GitHub-owned hosts are fetched (no arbitrary URLs / internal addresses), every redirect hop
//   is re-validated, and the GitHub token is only ever sent to the GitHub web host itself.
// - Size and count limits are enforced while streaming; the payload must be a real image (magic
//   bytes), so login pages / HTML errors are rejected.
// - Files are written under <workspace>/.symphony/attachments with symlink-safe writes, and the
//   directory carries its own `.gitignore` so the agent does not commit them.
import fs from "node:fs";
import path from "node:path";
import { isInside } from "../util.ts";

export interface ImageRef {
  url: string;
  alt: string | null;
}

export type ImageKind = { mime: string; ext: string; inlinable: boolean };

/** Max bytes for an image returned inline to the model (API limit is 5 MB base64 ≈ 3.75 MB raw). */
export const INLINE_MAX_BYTES = 3_750_000;

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e: string) => HTML_ENTITIES[e]);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

/**
 * Image references of one issue/comment. GitHub's rendered `body_html` is preferred because for
 * private repositories it carries short-lived signed URLs that work without a browser session;
 * the Markdown source is the fallback.
 */
export function extractImageRefs(markdown: string | null, html: string | null): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  const push = (url: string | null, alt: string | null) => {
    if (!url) return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, alt: alt && alt.trim() ? alt.trim() : null });
  };
  if (html && html.trim()) {
    // `src` is the fetchable URL (signed / camo-proxied); `data-canonical-src` is the original.
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) push(attr(m[0], "src"), attr(m[0], "alt"));
    return out;
  }
  const md = markdown ?? "";
  for (const m of md.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) push(m[2], m[1]);
  for (const m of md.matchAll(/<img\b[^>]*>/gi)) push(attr(m[0], "src"), attr(m[0], "alt"));
  return out;
}

/** Count of image references in Markdown (cheap hint for `github_issue_read`). */
export function countMarkdownImages(markdown: string | null): number {
  return extractImageRefs(markdown, null).length;
}

/**
 * Hosts Symphony is willing to fetch from: the GitHub web host (attachment paths only) and
 * GitHub's user-content CDNs. For GHES the web host and its subdomains are allowed.
 */
export function isAllowedImageUrl(raw: string, webUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const web = new URL(webUrl);
  const host = u.hostname.toLowerCase();
  const webHost = web.hostname.toLowerCase();
  if (webHost === "github.com") {
    if (u.protocol !== "https:" || (u.port && u.port !== "443")) return false;
    if (host === "github.com") return /^\/(user-attachments\/|[^/]+\/[^/]+\/(assets|raw|blob)\/)/.test(u.pathname);
    return host.endsWith(".githubusercontent.com");
  }
  // GitHub Enterprise Server: same scheme as the configured web URL, its host or subdomains.
  if (u.protocol !== web.protocol) return false;
  return host === webHost || host.endsWith(`.${webHost}`);
}

export function sniffImage(buf: Uint8Array): ImageKind | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png", inlinable: true };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", inlinable: true };
  if (b.length >= 6 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return { mime: "image/gif", ext: "gif", inlinable: true };
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    return { mime: "image/webp", ext: "webp", inlinable: true };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp", ext: "bmp", inlinable: false };
  const head = Buffer.from(b.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { mime: "image/svg+xml", ext: "svg", inlinable: false };
  return null;
}

export class AttachmentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Download one image with manual, re-validated redirects and a streaming size cap.
 * `token` is sent only to the GitHub web host (needed for some attachment URLs), never to CDNs.
 */
export async function downloadImage(
  fetchFn: typeof fetch,
  url: string,
  opts: { webUrl: string; token: string; maxBytes: number; timeoutMs: number },
): Promise<{ data: Buffer; kind: ImageKind; finalUrl: string }> {
  const webHost = new URL(opts.webUrl).hostname.toLowerCase();
  let current = url;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  for (let hop = 0; hop <= 5; hop++) {
    if (!isAllowedImageUrl(current, opts.webUrl)) {
      throw new AttachmentError("forbidden_url", `refusing to fetch non-GitHub URL ${stripQuery(current)}`);
    }
    const headers: Record<string, string> = { "User-Agent": "claude-symphony", Accept: "image/*,*/*;q=0.5" };
    if (new URL(current).hostname.toLowerCase() === webHost) headers.Authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await fetchFn(current, { method: "GET", headers, redirect: "manual", signal });
    } catch (err) {
      throw new AttachmentError("download_failed", `fetch ${stripQuery(current)} failed: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new AttachmentError("download_failed", `redirect without location from ${stripQuery(current)}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new AttachmentError("download_failed", `GET ${stripQuery(current)} -> HTTP ${res.status}`);
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > opts.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new AttachmentError("too_large", `image is ${len} bytes (limit ${opts.maxBytes})`);
    }
    const data = await readCapped(res, opts.maxBytes);
    const kind = sniffImage(data);
    if (!kind) {
      throw new AttachmentError(
        "not_an_image",
        `content at ${stripQuery(current)} is not a supported image (content-type ${res.headers.get("content-type") ?? "unknown"})`,
      );
    }
    return { data, kind, finalUrl: current };
  }
  throw new AttachmentError("download_failed", "too many redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AttachmentError("too_large", `image exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function stripQuery(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u.split("?")[0];
  }
}

export const ATTACHMENTS_REL_DIR = path.join(".symphony", "attachments");

/**
 * Ensure `<workspace>/.symphony/attachments` exists as a real directory inside the workspace
 * (the agent controls the workspace, so a symlinked `.symphony` must not redirect host writes).
 */
export function ensureAttachmentsDir(workspacePath: string): string {
  const wsReal = fs.realpathSync(workspacePath);
  const base = path.join(wsReal, ".symphony");
  const dir = path.join(base, "attachments");
  for (const d of [base, dir]) {
    try {
      fs.mkdirSync(d);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AttachmentError("unsafe_path", `${d} is not a plain directory`);
  }
  if (!isInside(wsReal, fs.realpathSync(dir))) throw new AttachmentError("unsafe_path", "attachments dir escapes the workspace");
  const gi = path.join(base, ".gitignore");
  if (!fs.existsSync(gi)) writeFileNoFollow(gi, "*\n");
  return dir;
}

/** Replace `file` without following a pre-existing symlink at that path. */
export function writeFileNoFollow(file: string, data: string | Uint8Array): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o644 });
}
