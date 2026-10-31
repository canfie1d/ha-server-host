// HTML for the Server Host panel: the overview, one page per server, Add server and the Host page.
// Served behind HA ingress; every URL is relative to the <base> the server passes in.
import { STATUS_LABEL } from './server.mjs';

export const BASE_CSS = `
:root{color-scheme:light;--bg:#f3f4f6;--fg:#1c1e21;--muted:#5c6570;--line:#d5dbe3;--card:#fff;--ok:#137333;--bad:#c5221f;--warn:#8a5a00;--accent:#0b6b4a;--field:#fff;--shadow:0 1px 0 rgba(28,30,33,.04);--nav:#eceef1;--sel:rgba(11,107,74,.12)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111111;--fg:#e8eaed;--muted:#9aa0a6;--line:#2c333a;--card:#1a1e23;--ok:#3dd68c;--bad:#ff7b72;--warn:#e6b450;--accent:#7dcea0;--field:#12161a;--shadow:none;--nav:#16191d;--sel:rgba(125,206,160,.14)}}
html,body{background:var(--bg);color:var(--fg)}
body{font:14px/1.45 Roboto,Noto,"Segoe UI",system-ui,sans-serif;margin:0}
h1{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0;overflow-wrap:anywhere}
h2{font-size:16px;font-weight:650;margin:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:4px 0 18px}
.overall{margin:2px 0 0;color:var(--muted);font-size:13px}
a.btn,button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;white-space:nowrap}
a.btn:hover,button:hover{border-color:var(--muted);text-decoration:none}
button.primary,a.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad);border-color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
.panel{border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);padding:16px}
.panel p{margin:0}
.hint{color:var(--muted);font-size:13px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.section-title{margin:28px 0 10px}
.pill{flex:none;font-size:12px;font-weight:650;line-height:1.5;padding:0 8px;border:1px solid currentColor;border-radius:999px}
.healthy{--st:var(--ok)}.down,.failed,.broken{--st:var(--bad)}.attention,.starting,.needs-settings,.busy,.unknown{--st:var(--warn)}.stopped{--st:var(--muted)}
.pill{color:var(--st,var(--warn))}
.notice{margin:0 0 16px;padding:10px 14px;border:1px solid var(--warn);border-radius:10px;color:var(--warn);font-size:13px}
.incidents{list-style:none;margin:8px 0 0;padding:0}
.incidents li{padding:10px 0;border-top:1px solid var(--line)}
.incidents li:first-child{border-top:0;padding-top:0}
.incidents time{display:block;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.inc-main{margin-top:2px}
.inc-fail{color:var(--muted)}
.shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;align-self:start;height:100vh;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:16px 10px;background:var(--nav);border-right:1px solid var(--line)}
.side .brand{font-weight:650;font-size:15px;padding:4px 10px 12px}
.side .group{color:var(--muted);font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:14px 10px 4px}
.side a{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;color:var(--fg);min-width:0}
.side a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side a:hover{background:var(--sel);text-decoration:none}
.side a[aria-current]{background:var(--sel);color:var(--accent);font-weight:600}
.side .foot{margin-top:auto;padding-top:14px;display:flex;flex-direction:column;gap:2px}
.side .none{color:var(--muted);font-size:13px;padding:4px 10px}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--st,var(--muted))}
main{min-width:0;max-width:900px;padding:24px 20px 48px;box-sizing:border-box}
input,textarea{font:inherit;font-size:13px;width:100%;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--field);color:var(--fg)}
input[type=checkbox]{width:auto}
.msg{margin-top:10px;font-size:13px}.msg:empty{display:none}
.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:2px 24px;margin:0}
.facts div{display:grid;grid-template-columns:7.5rem minmax(0,1fr);gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:13.5px}
.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
.warn{color:var(--warn)}
.mono{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.sub{display:block;color:var(--muted);font-size:12.5px}
.kv{width:100%;border-collapse:collapse}
.kv td{padding:8px 0;border-top:1px solid var(--line);vertical-align:middle}
.kv tr:first-child td{border-top:0}
.kv td.name{width:34%;padding-right:12px;overflow-wrap:anywhere}
.kv td.act{width:1%;white-space:nowrap;padding-left:8px}
.kv td.val{width:22%;padding-right:8px}.kv td input{min-width:140px}.kv td.val code{overflow-wrap:anywhere;word-break:break-all}.kv td.val .none{color:var(--muted)}
.tag{display:inline-block;margin-left:6px;font:600 11px/1.6 Roboto,system-ui,sans-serif;padding:0 6px;border-radius:999px;border:1px solid currentColor;vertical-align:1px}
.tag.set{color:var(--ok)}.tag.missing{color:var(--warn)}.tag.extra,.tag.optional{color:var(--muted)}
.add{display:grid;grid-template-columns:38% minmax(0,1fr) auto;gap:8px 12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
@media (max-width:720px){
.shell{grid-template-columns:minmax(0,1fr)}
.side{position:static;height:auto;flex-direction:row;align-items:center;overflow-x:auto;gap:4px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}
.side .brand,.side .group{display:none}
.side .foot{margin:0;padding:0;flex-direction:row;gap:4px}
.side a{flex:none}
main{padding:18px 16px 40px}
}
@media (max-width:560px){.kv td.name{width:auto}.kv tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.kv td{border:0;padding:0}.kv tr{border-top:1px solid var(--line);padding:10px 0}.kv tr:first-child{border-top:0;padding-top:0}.kv td.name{grid-column:1/-1}.add{grid-template-columns:minmax(0,1fr) auto}.add input:first-child{grid-column:1/-1}}
`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const statusClass = (s) => (STATUS_LABEL[s] ? s : 'unknown');
const pill = (s) => `<span class="pill ${statusClass(s)}">${esc(STATUS_LABEL[s] || s || 'unknown')}</span>`;
const serverHref = (name) => `server/${encodeURIComponent(name)}`;
// Data handed to inline scripts; "<" is escaped so a value can never close the script tag.
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
// Times show in Home Assistant's time zone (the Supervisor passes it as TZ), Pacific when unset.
const TIME_FORMAT = (() => {
  const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: process.env.TZ || 'America/Los_Angeles' });
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'America/Los_Angeles' });
  }
})();
const when = (iso) => {
  if (!iso) return '';
  const t = new Date(iso);
  return `<time datetime="${esc(iso)}">${esc(Number.isNaN(t.getTime()) ? iso : TIME_FORMAT.format(t))}</time>`;
};

// Shared by every page's script: escaping, element lookup and JSON requests.
const CLIENT = `
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function call(method,url,body){
  const r=await fetch(url,{method,cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let j={};try{j=await r.json()}catch{}
  if(!r.ok||j.ok===false)throw new Error((j.errors||[j.error||('HTTP '+r.status)]).join('; '));
  return j;
}
async function waitJob(id,onProgress){
  for(;;){
    await new Promise(r=>setTimeout(r,1000));
    const j=await call('GET','api/jobs/'+id);
    if(j.state==='done')return j.result;
    if(j.state==='error')throw new Error(j.error);
    onProgress(j.progress||'working');
  }
}
`;

function overallLine(snaps) {
  if (!snaps.length) return 'No servers yet';
  const bad = snaps.filter((s) => ['down', 'failed', 'broken'].includes(s.status)).length;
  const attention = snaps.filter((s) => ['attention', 'needs-settings'].includes(s.status)).length;
  const busy = snaps.filter((s) => ['starting', 'busy'].includes(s.status)).length;
  if (bad) return `${bad} down`;
  if (attention) return `${attention} need${attention === 1 ? 's' : ''} attention`;
  if (busy) return `${busy} starting`;
  return 'All servers healthy';
}

/** Page skeleton shared by every view: the side nav listing each server, then the page's content. */
function shell({ title, css = '', body, head = '', layout }) {
  const { base, nav, current, settingsUrl } = layout;
  const cur = (key) => (current === key ? ' aria-current="page"' : '');
  const items = nav.length
    ? nav.map((s) => `<a href="${esc(serverHref(s.name))}"${cur(`server:${s.name}`)}><i class="dot ${statusClass(s.status)}"></i><span>${esc(s.title)}</span></a>`).join('')
    : '<p class="none">No servers yet</p>';
  const addon = settingsUrl ? `<a href="${esc(settingsUrl)}" target="_top"><span>Add-on settings</span></a>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<base href="${esc(base)}">
<title>${esc(title)}</title>${head}
<style>${BASE_CSS}${css}</style>
<body><div class="shell">
<nav class="side" aria-label="Server Host">
<div class="brand">Server Host</div>
<a href="./"${cur('')}><span>Overview</span></a>
<div class="group">Servers</div>
${items}
<div class="foot"><a href="add"${cur('add')}><span>Add server</span></a><a href="host"${cur('host')}><span>Host</span></a>${addon}</div>
</nav>
<main>${body}</main>
</div>`;
}

function incidentItem(i, withServer = true) {
  const failure = i.failure ? `: ${esc(i.failure)}` : '';
  const who = withServer && i.server ? `<b>${esc(i.server)}</b> ` : '';
  return `<li>${when(i.at)}<div class="inc-main">${who}${esc(i.action || 'unresolved')}<span class="inc-fail">${failure}</span></div></li>`;
}

const incidentList = (incidents, withServer) => incidents.length
  ? `<ul class="incidents">${incidents.map((i) => incidentItem(i, withServer)).join('')}</ul>`
  : '<p class="hint">None yet.</p>';

const CARD_CSS = `
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
a.card{display:block;color:inherit;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);padding:16px;min-width:0}
a.card:hover{text-decoration:none;border-color:var(--muted)}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.card-top h2{word-break:break-word}
.desc{margin:8px 0 0;color:var(--muted);font-size:13px}
.desc:empty{display:none}
dl.c{margin:12px 0 0}
dl.c div{display:grid;grid-template-columns:6.5rem 1fr;gap:8px;padding:3px 0;font-size:13.5px}
dl.c dt{color:var(--muted)}
dl.c dd{margin:0;text-align:right;overflow-wrap:anywhere}
.detail{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.card.attention .detail,.card.needs-settings .detail,.card.starting .detail,.card.busy .detail{color:var(--warn)}
.card.down .detail,.card.failed .detail,.card.broken .detail{color:var(--bad)}
`;

function card(s) {
  return `<a class="card ${statusClass(s.status)}" href="${esc(serverHref(s.name))}">
<div class="card-top"><h2>${esc(s.title)}</h2>${pill(s.status)}</div>
<p class="desc">${esc(s.description)}</p>
<dl class="c">
<div><dt>Version</dt><dd>${esc(s.tag || '-')}</dd></div>
<div><dt>Hostname</dt><dd>${esc(s.hostnames[0] || 'none')}${s.hostnames.length > 1 ? ` +${s.hostnames.length - 1}` : ''}</dd></div>
</dl>
${s.detail ? `<p class="detail">${esc(s.detail)}</p>` : ''}
</a>`;
}

export function overviewPage(snaps, incidents, layout) {
  const cards = snaps.length
    ? `<div class="grid">${snaps.map(card).join('')}</div>`
    : `<section class="panel"><h2>No servers yet</h2><p style="margin-top:8px">Give the host a GitHub repo on <a href="add">Add server</a>. It installs the repo's latest release, keeps it running and routes its hostname to it.</p></section>`;
  return shell({
    title: 'Server Host',
    head: '<meta http-equiv="refresh" content="30">',
    css: CARD_CSS,
    layout,
    body: `${layout.notice ? `<p class="notice">${esc(layout.notice)}</p>` : ''}
<header class="top"><div><h1>Overview</h1><p class="overall">${esc(overallLine(snaps))}</p></div><a class="btn primary" href="add">Add server</a></header>
${cards}
<h2 class="section-title">Recent incidents</h2>
<section class="panel">${incidentList(incidents, true)}</section>`,
  });
}

const SERVER_CSS = `
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:4px 0 6px}
.title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.lede{margin:0 0 4px;color:var(--muted)}
#detail{margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
#detail.warn{color:var(--warn)}#detail.bad{color:var(--bad)}
.logbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0 10px}
.logbar h2{margin:0}
.logtools{display:flex;align-items:center;gap:8px}
pre#log{margin:0;max-height:420px;overflow:auto;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:var(--field);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--fg);padding:20px;max-width:440px}
dialog::backdrop{background:rgba(0,0,0,.4)}
dialog label{display:flex;gap:8px;align-items:flex-start;margin-top:10px}
.danger-zone{border-color:var(--bad)}
.tabs{display:flex;gap:2px;margin:20px 0 16px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 14px;color:var(--muted);font-weight:600}
.tabs button:hover{color:var(--fg)}
.tabs button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}
.tabs .count{margin-left:6px;font-weight:500;font-size:12px}
[role=tabpanel] .logbar{margin-top:0}
`;

/** One server's page: status and actions, its release, hostnames, settings, logs and incidents. */
export function serverPage(d, layout) {
  const repoUrl = `https://github.com/${d.repo}`;
  const host0 = d.hostnames[0];
  const endpoint = (p) => (host0 ? `<a class="mono" href="https://${esc(host0)}${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a>` : `<span class="mono">${esc(p)}</span>`);
  const endpoints = d.healthPaths
    ? `${endpoint(d.healthPaths.heartbeat)} alive, ${endpoint(d.healthPaths.health)} usable${d.mcpPath ? `<span class="sub">MCP at <span class="mono">${esc(host0 ? `https://${host0}${d.mcpPath}` : d.mcpPath)}</span></span>` : ''}`
    : '-';
  return shell({
    title: `${d.title} · Server Host`,
    css: SERVER_CSS,
    layout,
    body: `<header class="head">
<div class="title"><h1>${esc(d.title)}</h1><span id="pill">${pill(d.status)}</span></div>
<div class="actions"><button id="startstop"></button><button id="restart">Restart</button><button id="update" title="Install the latest release of ${esc(d.repo)}">Update</button></div>
</header>
${d.description ? `<p class="lede">${esc(d.description)}</p>` : ''}
<p id="detail"></p>
<div class="msg" id="amsg"></div>

<div class="tabs" role="tablist" aria-label="${esc(d.title)}">
<button role="tab" id="tab-details" aria-controls="details">Details</button>
<button role="tab" id="tab-settings" aria-controls="settings">Settings</button>
<button role="tab" id="tab-hostnames" aria-controls="hostnames">Hostnames</button>
<button role="tab" id="tab-logs" aria-controls="logs">Logs</button>
<button role="tab" id="tab-incidents" aria-controls="incidents">Incidents${d.incidents.length ? `<span class="count">${d.incidents.length}</span>` : ''}</button>
</div>

<div role="tabpanel" id="details" aria-labelledby="tab-details">
<section class="panel"><dl class="facts">
<div><dt>Installed</dt><dd>${d.current ? `${esc(d.current.tag)}<span class="sub">${when(d.current.installedAt)}</span>` : '<span class="warn">none</span>'}</dd></div>
<div><dt>Previous</dt><dd>${d.previous ? `${esc(d.previous.tag)} <button id="rollback" style="margin-left:6px">Roll back</button>` : '<span class="hint">none kept</span>'}</dd></div>
<div><dt>Repo</dt><dd><a href="${esc(repoUrl)}" target="_blank" rel="noopener">${esc(d.repo)}</a><span class="sub"><a href="${esc(repoUrl)}/releases" target="_blank" rel="noopener">releases</a></span></dd></div>
<div><dt>Updates</dt><dd><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="auto"${d.autoUpdate ? ' checked' : ''}> install new releases automatically</label>${d.rejected ? `<span class="sub warn">${esc(d.rejected)} failed its health check and is not retried on its own</span>` : ''}</dd></div>
<div><dt>Endpoints</dt><dd>${endpoints}</dd></div>
<div><dt>Internal port</dt><dd>${esc(d.port)}<span class="sub">data in <span class="mono">${esc(d.dataDir)}</span></span></dd></div>
</dl></section>
<h2 class="section-title">Remove</h2>
<section class="panel danger-zone"><p class="hint" style="margin-bottom:10px">Stops ${esc(d.title)} and deletes its installed releases. Other servers keep running.</p><button id="remove" class="danger">Remove ${esc(d.title)}</button></section>
</div>

<div role="tabpanel" id="hostnames" aria-labelledby="tab-hostnames" hidden>
<section class="panel">
<p class="hint" style="margin-bottom:10px">Requests for these hostnames go to this server. In Cloudflare Tunnel, point each one at <span class="mono">http://&lt;Home Assistant host&gt;:${esc(layout.routerPort)}</span>. The first one is passed to the server as <code>PUBLIC_URL</code> unless a setting below overrides it.</p>
<textarea id="hosts" rows="3" spellcheck="false" placeholder="app.example.com">${esc(d.hostnames.join('\n'))}</textarea>
<div class="row"><button id="savehosts" class="primary">Save hostnames</button></div>
<div class="msg" id="hmsg"></div>
</section>
</div>

<div role="tabpanel" id="settings" aria-labelledby="tab-settings" hidden>
<section class="panel">
<p class="hint" style="margin-bottom:10px">Passed to the server as environment variables and stored in the host's private <code>/data</code>. Secret values stay hidden until you choose Show. Saving applies the change right away by restarting this server only.</p>
<div style="text-align:right;margin-bottom:6px"><button id="revealall" hidden>Show all</button></div>
<table class="kv"><tbody id="srows"></tbody></table>
<form class="add" id="sadd" autocomplete="off"><input id="sname" placeholder="OTHER_VARIABLE" spellcheck="false" aria-label="Variable name"><input id="sval" type="password" placeholder="value" aria-label="Variable value"><button class="primary">Add</button></form>
<div class="msg" id="smsg"></div>
</section>
</div>

<div role="tabpanel" id="logs" aria-labelledby="tab-logs" hidden>
<div class="logbar"><h2>Logs</h2><div class="logtools"><span class="hint" id="logstate">live</span><button id="copylog">Copy</button><button id="savelog">Download</button></div></div>
<pre id="log"></pre>
</div>

<div role="tabpanel" id="incidents" aria-labelledby="tab-incidents" hidden>
<section class="panel">${incidentList(d.incidents, false)}</section>
</div>

<dialog id="rmdlg"><form method="dialog">
<h2>Remove ${esc(d.title)}?</h2>
<p class="hint" style="margin-top:8px">The server is stopped and its releases are deleted.</p>
<label><input type="checkbox" id="keepSettings" checked> Keep its settings, so adding it again restores them</label>
<label><input type="checkbox" id="keepData" checked> Keep its data folder</label>
<div class="row" style="justify-content:flex-end"><button value="cancel">Cancel</button><button id="rmok" class="danger" value="ok">Remove</button></div>
</form></dialog>

<script>
${CLIENT}
const NAME=${json(d.name)};
const API='api/server/'+encodeURIComponent(NAME);
let data=${json({ status: d.status, detail: d.detail, busy: d.busy, enabled: d.enabled, logTail: d.logTail, fields: d.fields, settings: d.settings })};
const LABEL=${json(STATUS_LABEL)};
const cls=s=>LABEL[s]?s:'unknown';
function amsg(c,t){$('amsg').className='msg '+c;$('amsg').textContent=t}
function renderStatus(){
  $('pill').innerHTML='<span class="pill '+cls(data.status)+'">'+esc(LABEL[data.status]||data.status)+'</span>';
  $('detail').textContent=data.detail||'';
  $('detail').className=['down','failed','broken'].includes(data.status)?'bad':['attention','needs-settings'].includes(data.status)?'warn':'';
  const busy=!!data.busy;
  $('startstop').textContent=data.enabled?'Stop':'Start';
  $('startstop').disabled=busy;
  $('restart').disabled=busy||!data.enabled||data.status==='needs-settings'||data.status==='broken';
  $('update').disabled=busy;
  if($('rollback'))$('rollback').disabled=busy;
}
const pad=n=>String(n).padStart(2,'0');
// Lines arrive as "<ISO time> text"; show the time in this browser's zone.
function localLine(l){
  const m=/^(\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z) (.*)$/.exec(l);
  if(!m)return l;
  const t=new Date(m[1]);
  if(isNaN(t))return l;
  return t.getFullYear()+'-'+pad(t.getMonth()+1)+'-'+pad(t.getDate())+' '+pad(t.getHours())+':'+pad(t.getMinutes())+':'+pad(t.getSeconds())+'  '+m[2];
}
const logText=()=>(data.logTail||[]).map(localLine).join('\\n');
function selectingLog(){
  const s=getSelection();
  return s&&!s.isCollapsed&&s.rangeCount&&$('log').contains(s.getRangeAt(0).commonAncestorContainer);
}
function renderLogs(){
  const el=$('log'),atEnd=el.scrollHeight-el.scrollTop-el.clientHeight<24;
  if(selectingLog()){$('logstate').textContent='paused while selecting';return}
  el.textContent=logText()||'No output yet.';
  if(atEnd)el.scrollTop=el.scrollHeight;
  $('logstate').textContent=atEnd?'live':'live, scrolled up';
}
function logNote(t){$('logstate').textContent=t;setTimeout(renderLogs,2500)}
// The HA ingress iframe may not allow the async clipboard API, so fall back to execCommand,
// then to selecting the log for a manual copy.
$('copylog').onclick=async()=>{
  const text=logText();
  let ok=false;
  try{await navigator.clipboard.writeText(text);ok=true}catch{}
  if(!ok){
    const t=document.createElement('textarea');
    t.value=text;t.setAttribute('readonly','');t.style.cssText='position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(t);t.select();
    try{ok=document.execCommand('copy')}catch{}
    t.remove();
  }
  if(ok){logNote('copied '+(data.logTail||[]).length+' lines');return}
  const r=document.createRange();r.selectNodeContents($('log'));
  const s=getSelection();s.removeAllRanges();s.addRange(r);
  $('logstate').textContent='selected; press Ctrl+C or Cmd+C';
};
$('savelog').onclick=()=>{
  const t=new Date(),stamp=t.getFullYear()+pad(t.getMonth()+1)+pad(t.getDate())+'-'+pad(t.getHours())+pad(t.getMinutes());
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([logText()+'\\n'],{type:'text/plain'}));
  a.download=NAME+'-'+stamp+'.log';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};

// ---- settings
let vals=null;const shown=new Set();
async function fetchVals(){
  if(vals)return true;
  const r=await fetch(API+'/settings',{cache:'no-store',headers:{'x-requested-with':'admin'}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){smsg('bad',(j.errors||['Could not load values']).join('; '));return false}
  vals=j.values;return true;
}
function smsg(c,t){$('smsg').className='msg '+c;$('smsg').textContent=t}
function renderSettings(){
  const f=data.fields,s=data.settings,set=new Set(s.set),declared=new Set(f.flatMap(x=>[x.env,...(x.aliases||[])]));
  // A value stored under an older name the server also reads gets its own row, marked as such.
  const aliasRows=f.flatMap(x=>(x.aliases||[]).filter(a=>set.has(a)).map(a=>({env:a,label:x.label,secret:x.secret,aliasOf:x.env})));
  const rows=[...f,...aliasRows,...s.set.filter(n=>!declared.has(n)).map(n=>({env:n,label:'',secret:true,extra:true}))];
  const secretSet=rows.filter(r=>r.secret&&set.has(r.env));
  $('revealall').hidden=!secretSet.length;$('revealall').textContent=shown.size?'Hide all':'Show all';
  $('srows').innerHTML=rows.length?rows.map(r=>{
    const n=r.env,has=set.has(n);
    const viaAlias=!has&&(r.aliases||[]).find(a=>set.has(a));
    const tag=r.extra?'<span class="tag extra" title="Not declared by this server">extra</span>':r.aliasOf?'<span class="tag set">older name for '+esc(r.aliasOf)+'</span>':has?'<span class="tag set">set</span>':viaAlias?'<span class="tag set">set as '+esc(viaAlias)+'</span>':r.required&&!r.default?'<span class="tag missing">required</span>':'<span class="tag optional">optional</span>';
    const label=r.label?esc(r.label)+'<span class="sub"><code>'+esc(n)+'</code>'+tag+'</span>':'<code>'+esc(n)+'</code>'+tag;
    const note=r.note?'<span class="sub">'+esc(r.note)+'</span>':'';
    let val;
    if(!has)val=r.default?'<span class="none">default: '+esc(r.default)+'</span>':'<span class="none">not set</span>';
    else if(!r.secret)val='<code>'+esc(s.plain[n]??'')+'</code>';
    else val='<code>'+(shown.has(n)&&vals&&n in vals?esc(vals[n]):'••••••••')+'</code>';
    const reveal=has&&r.secret?'<button data-op="show">'+(shown.has(n)?'Hide':'Show')+'</button> ':'';
    return '<tr data-name="'+esc(n)+'"><td class="name">'+label+note+'</td><td class="val">'+val+'</td>'
      +'<td><input type="'+(r.secret?'password':'text')+'" autocomplete="new-password" placeholder="'+(has?'new value':'value')+'" aria-label="'+esc(n)+' value"></td>'
      +'<td class="act">'+reveal+'<button data-op="save">Save</button> '+(has?'<button data-op="remove">Remove</button>':'')+'</td></tr>';
  }).join(''):'<tr><td class="hint">This server declares no settings.</td></tr>';
}
async function putSettings(body){
  try{
    const j=await call('PUT',API+'/settings',body);
    data.settings.set=j.set;data.settings.missing=j.missing;
    if(body.set)for(const [k,v] of Object.entries(body.set))if(data.fields.some(x=>x.env===k&&!x.secret))data.settings.plain[k]=v;
    vals=null;shown.clear();renderSettings();
    smsg('ok','Saved.'+(j.action==='restart'?' Restarting with the new values.':j.action==='start'?' Starting now.':j.action==='deferred'?' The server is busy; the values apply when it next starts.':j.missing.length?' Still missing: '+j.missing.join(', ')+'.':''));
    refresh();return true;
  }catch(e){smsg('bad',e.message);return false}
}
$('srows').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  const row=b.closest('tr'),n=row.dataset.name,input=row.querySelector('input');
  if(b.dataset.op==='show'){if(shown.has(n)){shown.delete(n);if(!shown.size)vals=null}else if(await fetchVals())shown.add(n);renderSettings();return}
  if(b.dataset.op==='remove'){if(confirm('Remove '+n+'?'))await putSettings({remove:[n]});return}
  if(b.dataset.op!=='save')return;
  if(!input.value){input.focus();smsg('bad','Enter a value for '+n+' first.');return}
  if(await putSettings({set:{[n]:input.value}}))input.value='';
});
$('srows').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('input')){e.preventDefault();e.target.closest('tr').querySelector('[data-op=save]').click()}});
$('revealall').onclick=async()=>{if(shown.size){shown.clear();vals=null}else if(await fetchVals())data.settings.set.forEach(n=>shown.add(n));renderSettings()};
$('sadd').addEventListener('submit',async e=>{
  e.preventDefault();
  const n=$('sname').value.trim(),v=$('sval').value;
  if(!n||!v){smsg('bad','Enter a name and a value.');return}
  if(await putSettings({set:{[n]:v}})){$('sname').value='';$('sval').value=''}
});

// ---- hostnames, actions
$('savehosts').onclick=async()=>{
  const list=$('hosts').value.split(/[\\s,]+/).filter(Boolean);
  const m=$('hmsg');
  try{const j=await call('PUT',API+'/hostnames',{hostnames:list});$('hosts').value=j.hostnames.join('\\n');m.className='msg ok';m.textContent='Saved.'+(j.action==='restart'?' Restarting with the new PUBLIC_URL.':'');refresh()}
  catch(e){m.className='msg bad';m.textContent=e.message}
};
$('auto').onchange=async e=>{try{await call('PUT',API+'/options',{autoUpdate:e.target.checked})}catch(err){e.target.checked=!e.target.checked;amsg('bad',err.message)}};
async function act(op,confirmText){
  if(confirmText&&!confirm(confirmText))return;
  amsg('','');
  try{await call('POST',API+'/'+op,{});}catch(e){amsg('bad',e.message)}
  refresh();
}
$('startstop').onclick=()=>data.enabled?act('stop','Stop '+NAME+'? It stays stopped until you start it again.'):act('start');
$('restart').onclick=()=>act('restart');
if($('rollback'))$('rollback').onclick=()=>act('rollback','Go back to the previous release? The current one is not installed again automatically.').then(()=>setTimeout(()=>location.reload(),4000));
$('update').onclick=async()=>{
  $('update').disabled=true;amsg('','Checking for a new release...');
  try{
    const {id}=await call('POST',API+'/update',{});
    const r=await waitJob(id,p=>amsg('',p));
    amsg(r.reverted?'bad':'ok',r.message.charAt(0).toUpperCase()+r.message.slice(1)+'.');
    if(r.updated||r.reverted)setTimeout(()=>location.reload(),2500);
  }catch(e){amsg('bad',e.message)}
  refresh();
};
$('remove').onclick=()=>$('rmdlg').showModal();
$('rmdlg').addEventListener('close',async()=>{
  if($('rmdlg').returnValue!=='ok')return;
  try{await call('POST',API+'/remove',{keepSettings:$('keepSettings').checked,keepData:$('keepData').checked});location.href='./'}
  catch(e){amsg('bad',e.message)}
});

// ---- tabs; the open one is kept in the URL fragment so a reload stays on it
const TABS=[...document.querySelectorAll('[role=tab]')];
function openTab(id,focus){
  const tab=TABS.find(t=>t.getAttribute('aria-controls')===id)||TABS[0];
  for(const t of TABS){
    const on=t===tab;
    t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;
    $(t.getAttribute('aria-controls')).hidden=!on;
  }
  if(focus)tab.focus();
  history.replaceState(null,'',location.pathname+location.search+'#'+tab.getAttribute('aria-controls'));
  // A hidden log has no height, so jump to the newest lines once it is shown.
  if(tab.id==='tab-logs')$('log').scrollTop=$('log').scrollHeight;
}
TABS.forEach(t=>t.onclick=()=>openTab(t.getAttribute('aria-controls')));
$('tab-details').parentElement.addEventListener('keydown',e=>{
  const i=TABS.indexOf(document.activeElement);if(i<0)return;
  const n={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:TABS.length-1}[e.key];
  if(n===undefined)return;
  e.preventDefault();openTab(TABS[(n+TABS.length)%TABS.length].getAttribute('aria-controls'),true);
});
openTab(location.hash.slice(1));

let timer;
async function refresh(){
  clearTimeout(timer);
  try{
    const r=await fetch(API,{cache:'no-store'});
    if(r.ok){const j=await r.json();data={...data,status:j.status,detail:j.detail,busy:j.busy,enabled:j.enabled,logTail:j.logTail};renderStatus();renderLogs()}
  }catch{}
  timer=setTimeout(refresh,data.busy||data.status==='starting'?2000:5000);
}
renderStatus();renderLogs();renderSettings();$('log').scrollTop=$('log').scrollHeight;
timer=setTimeout(refresh,3000);
</script>`,
  });
}

export function addPage(layout) {
  return shell({
    title: 'Add server · Server Host',
    layout,
    body: `<header class="top"><div><h1>Add server</h1></div></header>
<section class="panel">
<p class="hint" style="margin-bottom:12px">The host downloads the repo's latest GitHub release (its <code>bundle-linux-x64.tar.gz</code> asset), reads the <code>ha-server.json</code> manifest inside it and creates the server's page. Fill in its settings there and it starts. Private repos need the GitHub token on the <a href="host">Host</a> page.</p>
<form id="addf" autocomplete="off">
<label for="repo" class="hint">GitHub repo</label>
<input id="repo" placeholder="owner/repo or https://github.com/owner/repo" spellcheck="false" style="margin:4px 0 10px">
<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="auto" checked> Install new releases automatically</label>
<div class="row"><button class="primary" id="go">Add server</button></div>
</form>
<div class="msg" id="msg"></div>
</section>
<script>
${CLIENT}
function msg(c,t){$('msg').className='msg '+c;$('msg').textContent=t}
$('addf').addEventListener('submit',async e=>{
  e.preventDefault();
  const repo=$('repo').value.trim();
  if(!repo){msg('bad','Enter a repo.');return}
  $('go').disabled=true;msg('','Starting...');
  try{
    const {id}=await call('POST','api/servers',{repo,autoUpdate:$('auto').checked});
    const r=await waitJob(id,p=>msg('',p.charAt(0).toUpperCase()+p.slice(1)+'...'));
    msg('ok','Added '+r.name+' '+r.tag+'.'+(r.missing.length?' Opening its page to fill in settings.':' Starting it now.'));
    setTimeout(()=>location.href='server/'+encodeURIComponent(r.name),1200);
  }catch(err){msg('bad',err.message);$('go').disabled=false}
});
</script>`,
  });
}

/** The host's own settings. */
export function hostPage(h, layout) {
  return shell({
    title: 'Host · Server Host',
    layout,
    body: `<header class="top"><div><h1>Host</h1><p class="overall">HA Server Host ${esc(h.version)} on Node ${esc(h.node)}. Public port ${esc(h.routerPort)}.</p></div></header>

<h2 class="section-title" style="margin-top:0">Host settings</h2>
<section class="panel">
<p class="hint" style="margin-bottom:10px">Stored in the host's private <code>/data</code>. Never passed to servers, except the shared Turso values for servers that ask for them.</p>
<table class="kv"><tbody id="hrows"></tbody></table>
<div class="msg" id="hmsg"></div>
</section>

<h2 class="section-title">Cloudflare Tunnel</h2>
<section class="panel"><p>Point every public hostname at <span class="mono">http://&lt;Home Assistant host&gt;:${esc(h.routerPort)}</span>. The host sends each request to the server that owns the hostname. <span class="mono">/heartbeat</span> and <span class="mono">/health</span> on any other hostname report on the host and all servers.</p></section>

<script>
${CLIENT}
const FIELDS=${json(h.fields)};
let state=${json(h.settings)};
let vals=null;const shown=new Set();
function hmsg(c,t){$('hmsg').className='msg '+c;$('hmsg').textContent=t}
async function fetchVals(){
  if(vals)return true;
  const r=await fetch('api/host/settings',{cache:'no-store',headers:{'x-requested-with':'admin'}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){hmsg('bad',(j.errors||['Could not load values']).join('; '));return false}
  vals=j.values;return true;
}
function render(){
  const set=new Set(state.set);
  $('hrows').innerHTML=FIELDS.map(f=>{
    const has=set.has(f.key);
    let val=!has?'<span class="none">not set</span>':!f.secret?'<code>'+esc(state.plain[f.key]??'')+'</code>':'<code>'+(shown.has(f.key)&&vals?esc(vals[f.key]):'••••••••')+'</code>';
    return '<tr data-key="'+f.key+'"><td class="name">'+esc(f.label)+'<span class="sub">'+esc(f.note||'')+'</span></td><td class="val">'+val+'</td>'
      +'<td><input type="'+(f.secret?'password':'text')+'" autocomplete="new-password" placeholder="'+(has?'new value':'value')+'"></td>'
      +'<td class="act">'+(has&&f.secret?'<button data-op="show">'+(shown.has(f.key)?'Hide':'Show')+'</button> ':'')+'<button data-op="save">Save</button> '+(has?'<button data-op="remove">Remove</button>':'')+'</td></tr>';
  }).join('');
}
async function put(body){
  try{state=await call('PUT','api/host/settings',body);vals=null;shown.clear();render();hmsg('ok','Saved.');return true}
  catch(e){hmsg('bad',e.message);return false}
}
$('hrows').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  const row=b.closest('tr'),k=row.dataset.key,input=row.querySelector('input');
  if(b.dataset.op==='show'){if(shown.has(k))shown.delete(k);else if(await fetchVals())shown.add(k);render();return}
  if(b.dataset.op==='remove'){if(confirm('Remove this setting?'))await put({remove:[k]});return}
  if(!input.value){input.focus();return}
  if(await put({set:{[k]:input.value}}))input.value='';
});
render();
</script>`,
  });
}
