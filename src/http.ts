// OPTIONAL HTTP server extension (SPEC §13.7): dashboard at `/`, JSON API under `/api/v1/*`.
// Observability/control only — never required for orchestrator correctness.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./log.ts";
import type { Orchestrator } from "./orchestrator.ts";

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body, null, 2));
}

function apiError(res: http.ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}) {
  json(res, status, { error: { code, message } }, extra);
}

export async function startHttpServer(
  orch: Orchestrator,
  opts: { port: number; host: string; log: Logger },
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const log = opts.log.child({ component: "http" });
  const server = http.createServer((req, res) => {
    try {
      route(orch, req, res);
    } catch (err) {
      log.error("http handler failed", { error: err });
      if (!res.headersSent) apiError(res, 500, "internal_error", "internal error");
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  log.info("http server listening", { url: `http://${opts.host}:${port}/` });
  return {
    server,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function route(orch: Orchestrator, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (p === "/") {
    if (method !== "GET" && method !== "HEAD") return apiError(res, 405, "method_not_allowed", "use GET", { allow: "GET" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (p === "/api/v1/state") {
    if (method !== "GET") return apiError(res, 405, "method_not_allowed", "use GET", { allow: "GET" });
    return json(res, 200, orch.snapshot());
  }
  if (p === "/api/v1/refresh") {
    if (method !== "POST") return apiError(res, 405, "method_not_allowed", "use POST", { allow: "POST" });
    req.resume();
    const { coalesced } = orch.requestRefresh();
    return json(res, 202, {
      queued: true,
      coalesced,
      requested_at: new Date().toISOString(),
      operations: ["poll", "reconcile"],
    });
  }
  if (p.startsWith("/api/v1/")) {
    const ident = decodeURIComponent(p.slice("/api/v1/".length));
    if (!ident || ident.includes("/")) return apiError(res, 404, "not_found", "unknown route");
    if (method !== "GET") return apiError(res, 405, "method_not_allowed", "use GET", { allow: "GET" });
    const detail = orch.issueDetail(ident);
    if (!detail) return apiError(res, 404, "issue_not_found", `issue ${ident} is unknown to the current runtime state`);
    return json(res, 200, detail);
  }
  apiError(res, 404, "not_found", "unknown route");
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Symphony</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e4e4df;--accent:#c2410c;--ok:#15803d;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a93;--card:#1e1e1c;--line:#30302d;--accent:#f97316;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:24px 0 8px}
main{max-width:1200px;margin:0 auto;padding:0 16px 32px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.tile span{color:var(--muted);font-size:12px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:720px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;text-align:center}th.num{text-align:center}.msg{color:var(--muted);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a{color:var(--accent)}button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
.err{color:var(--err)}.ok{color:var(--ok)}.empty{padding:14px;color:var(--muted)}code{font-size:12px}
.feeds{display:grid;gap:12px}.feed{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.feed h3{margin:0;padding:8px 12px;font-size:13px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:baseline}
.feed h3 span{color:var(--muted);font-weight:400}
.log{height:320px;overflow-y:auto;padding:6px 0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ev{display:grid;grid-template-columns:auto auto 1fr;gap:10px;padding:2px 12px;white-space:pre-wrap;word-break:break-word}
.ev time{color:var(--muted)}.ev i{font-style:normal;color:var(--muted)}.ev.tool i{color:var(--accent)}.ev.done i{color:var(--ok)}.ev.fail i{color:var(--err)}
@media (max-width:600px){.ev{grid-template-columns:auto 1fr}.ev i{display:none}}
</style></head><body>
<header><h1>Symphony <span style="color:var(--muted);font-weight:400">· Claude Code × GitHub Issues</span></h1>
<div><span id="health" class="ok"></span> <button id="refresh">Refresh now</button></div></header>
<main>
<div class="tiles" id="tiles"></div>
<h2>Running</h2><div class="wrap"><table><thead><tr><th>Issue</th><th>State</th><th class="num">Turns</th><th>Last event</th><th>Started</th><th class="num">Tokens</th></tr></thead><tbody id="running"></tbody></table></div>
<h2>Messages</h2><div class="feeds" id="feeds"></div>
<h2>Retry queue</h2><div class="wrap"><table><thead><tr><th>Issue</th><th class="num">Attempt</th><th>Due</th><th>Error</th></tr></thead><tbody id="retrying"></tbody></table></div>
<h2>Rate limits</h2><div class="wrap"><pre id="rl" class="empty" style="margin:0;white-space:pre-wrap"></pre></div>
</main>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rel=t=>{if(!t)return"–";const d=(Date.parse(t)-Date.now())/1000;const a=Math.abs(d);const v=a<60?Math.round(a)+"s":a<3600?Math.round(a/60)+"m":Math.round(a/3600)+"h";return d<0?v+" ago":"in "+v};
const link=(id,url)=>url?'<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(id)+'</a>':esc(id);
async function load(){
 try{const s=await (await fetch("api/v1/state")).json();
 const t=s.codex_totals;const tiles=[["Running",s.counts.running],["Retrying",s.counts.retrying],["Finished",s.counts.finished??0],["Total tokens",t.total_tokens.toLocaleString()],["Runtime",Math.round(t.seconds_running/60)+" min"]];
 document.getElementById("tiles").innerHTML=tiles.map(([k,v])=>'<div class="tile"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>').join("");
 const h=s.health;const he=document.getElementById("health");const e=h.config_error||h.last_tick_error;he.className=e?"err":"ok";he.textContent=e?e:("healthy · last poll "+rel(h.last_tick_at));
 document.getElementById("running").innerHTML=s.running.length?s.running.map(r=>'<tr><td>'+link(r.issue_identifier,r.issue_url)+'<div class="msg">'+esc(r.title)+'</div></td><td>'+esc(r.state)+(r.stopping?' <span class="err">(stopping: '+esc(r.stopping)+')</span>':'')+'</td><td class="num">'+r.turn_count+'</td><td>'+esc(r.last_event??"–")+'<div class="msg">'+rel(r.last_event_at)+'</div></td><td>'+rel(r.started_at)+'</td><td class="num">'+r.tokens.total_tokens.toLocaleString()+'</td></tr>').join(""):'<tr><td colspan="6" class="empty">No active sessions</td></tr>';
 renderFeeds(s.running);
 document.getElementById("retrying").innerHTML=s.retrying.length?s.retrying.map(r=>'<tr><td>'+link(r.issue_identifier,r.issue_url)+'</td><td class="num">'+r.attempt+'</td><td>'+rel(r.due_at)+'</td><td class="msg">'+esc(r.error??"continuation")+'</td></tr>').join(""):'<tr><td colspan="4" class="empty">Queue empty</td></tr>';
 document.getElementById("rl").textContent=s.rate_limits?JSON.stringify(s.rate_limits,null,2):"No rate-limit data yet";
 }catch(e){const he=document.getElementById("health");he.className="err";he.textContent="state unavailable: "+e.message}
}
// Message feeds: one scrolling log per running issue. Each log is only re-rendered when it gets
// new events. Newest events are shown first; the log stays at the top unless the reader has
// scrolled down, in which case their reading position is preserved.
const feedState=new Map();
const clock=t=>{const d=new Date(t);return isNaN(d)?"":d.toLocaleTimeString([], {hour12:false})};
const evClass=e=>e.event==="turn_completed"?"done":/failed|error|timeout|cancel/.test(e.event)?"fail":/^\\[tool\\]/.test(e.message||"")||e.event.startsWith("tool_")?"tool":"";
function renderFeeds(running){
 const box=document.getElementById("feeds");
 if(!running.length){box.innerHTML='<div class="feed"><div class="empty">No active sessions</div></div>';feedState.clear();return}
 if(box.querySelector(".empty"))box.innerHTML="";
 const ids=new Set(running.map(r=>r.issue_id));
 for(const [id,st] of feedState)if(!ids.has(id)){st.el.remove();feedState.delete(id)}
 for(const r of running){
  let st=feedState.get(r.issue_id);
  if(!st){const el=document.createElement("div");el.className="feed";el.innerHTML='<h3></h3><div class="log"></div>';box.appendChild(el);st={el,key:null};feedState.set(r.issue_id,st)}
  st.el.querySelector("h3").innerHTML=link(r.issue_identifier,r.issue_url)+' <span>'+esc(r.title)+'</span>';
  const evs=(r.recent_events||[]).filter(e=>e.message&&e.message!=="[tool result]");
  const last=evs[evs.length-1];const key=evs.length+"|"+(last?last.at+last.event+last.message:"");
  if(key===st.key)continue;st.key=key;
  const log=st.el.querySelector(".log");const atTop=log.scrollTop<24;const prevH=log.scrollHeight,prevTop=log.scrollTop;
  log.innerHTML=evs.length?evs.slice().reverse().map(e=>'<div class="ev '+evClass(e)+'"><time>'+clock(e.at)+'</time><i>'+esc(e.event)+'</i><span>'+esc(e.message)+'</span></div>').join(""):'<div class="empty">Waiting for agent output…</div>';
  log.scrollTop=atTop?0:prevTop+(log.scrollHeight-prevH);
 }
}
document.getElementById("refresh").onclick=async()=>{await fetch("api/v1/refresh",{method:"POST"});setTimeout(load,800)};
load();setInterval(load,2000);
</script></body></html>`;
