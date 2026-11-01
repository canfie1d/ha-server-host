// HA Server Host: runs each added server from its GitHub release as its own process, routes the
// public port by hostname, keeps every server healthy, and serves the panel on HA ingress.
import { createServer } from 'node:http';
import { log, recentIncidents, sleep } from './lib/util.mjs';
import { createStore, HOST_FIELDS } from './lib/store.mjs';
import { createNotifier } from './lib/notify.mjs';
import { createHost } from './lib/host.mjs';
import { createRouter } from './lib/router.mjs';
import { addPage, hostPage, overviewPage, serverPage } from './lib/pages.mjs';

const PANEL_PORT = Number(process.env.HOST_PANEL_PORT) || 8100; // HA ingress
const ROUTER_PORT = Number(process.env.HOST_ROUTER_PORT) || 8110; // the one published port
const CHECK_INTERVAL_MS = Number(process.env.HOST_CHECK_INTERVAL_MS) || 30_000;
const UPDATE_INTERVAL_MS = Number(process.env.HOST_UPDATE_INTERVAL_MS) || 2 * 60_000;
const SUPERVISOR_IP = '172.30.32.2';
const TRUST_ALL = process.env.HOST_TRUST_ALL === '1'; // local development only
const MAX_BODY = 256 * 1024;

const supervisorToken = process.env.SUPERVISOR_TOKEN || '';
// Servers get an environment built from scratch, but keep the token out of reach anyway.
delete process.env.SUPERVISOR_TOKEN;

// One server's failure must never take the host (and every other server) down.
process.on('uncaughtException', (err) => log('host', `uncaught: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log('host', `unhandled rejection: ${err?.stack || err}`));

const store = createStore();
const { notify, dismiss } = createNotifier({ supervisorToken, hostSettings: store.host });
const host = createHost({ store, notify, dismiss, reservedPorts: [PANEL_PORT, ROUTER_PORT] });

// This add-on's slug carries a repository hash and its version comes from config.yaml, so both
// are read from the Supervisor. Without it (local runs) the link is hidden and the version is "dev".
const self = { version: process.env.HOST_VERSION || 'dev', settingsUrl: null };
async function resolveSelf() {
  if (!supervisorToken) return;
  try {
    const r = await fetch('http://supervisor/addons/self/info', {
      headers: { authorization: `Bearer ${supervisorToken}` },
      signal: AbortSignal.timeout(5000),
    });
    const d = r.ok ? (await r.json())?.data : null;
    if (d?.slug) self.settingsUrl = `/config/app/${d.slug}/config`;
    if (d?.version) self.version = d.version;
  } catch {}
}

// ---- panel -----------------------------------------------------------------

function layout(req, current) {
  // HA ingress sends the panel's path prefix; pages use it as <base> so nested routes resolve.
  const prefix = String(req.headers['x-ingress-path'] || '');
  return {
    base: /^\/[\w\-/]*$/.test(prefix) ? `${prefix.replace(/\/+$/, '')}/` : '/',
    settingsUrl: self.settingsUrl,
    nav: host.snapshots().map(({ name, title, status }) => ({ name, title, status })),
    current,
    routerPort: ROUTER_PORT,
  };
}

function hostSettingsView() {
  const h = store.host();
  return {
    set: Object.keys(h).sort(),
    plain: Object.fromEntries(HOST_FIELDS.filter((f) => !f.secret && h[f.key] !== undefined).map((f) => [f.key, h[f.key]])),
  };
}

function hostView() {
  return {
    version: self.version,
    node: process.versions.node,
    routerPort: ROUTER_PORT,
    fields: HOST_FIELDS.map(({ key, label, secret = false, note = '' }) => ({ key, label, secret, note })),
    settings: hostSettingsView(),
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = MAX_BODY) {
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text || '{}');
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON: ${err.message}`), { status: 400 });
  }
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const sendJson = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
const fail = (res, status, ...errors) => sendJson(res, status, { ok: false, errors });
// State-changing requests must be JSON, which a cross-site form cannot send.
const isJson = (req) => String(req.headers['content-type'] || '').startsWith('application/json');
const peerOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

async function serverApi(req, res, url, name, op) {
  const method = req.method;
  host.get(name); // 404 for an unknown server
  if (!op && method === 'GET') return sendJson(res, 200, host.detail(name));
  if (op === 'settings' && method === 'GET') {
    // Plaintext values, only for the page's own fetch.
    if (req.headers['x-requested-with'] !== 'admin') return fail(res, 400, 'missing header');
    return sendJson(res, 200, { ok: true, values: host.secretValues(name) });
  }
  if (method === 'PUT') {
    const body = await readJsonBody(req);
    let out;
    if (op === 'settings') out = host.updateSettings(name, body);
    else if (op === 'hostnames') out = host.setHostnames(name, body.hostnames);
    else if (op === 'options') {
      if (typeof body.autoUpdate !== 'boolean') return fail(res, 400, '"autoUpdate" must be true or false');
      host.setAutoUpdate(name, body.autoUpdate);
      out = { ok: true };
    } else return fail(res, 405, 'method not allowed');
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  if (method !== 'POST') return fail(res, 405, 'method not allowed');
  const body = await readJsonBody(req);
  switch (op) {
    case 'start':
      host.start(name);
      return sendJson(res, 202, { ok: true });
    case 'stop':
      await host.stop(name);
      return sendJson(res, 200, { ok: true });
    case 'restart':
      host.restart(name);
      return sendJson(res, 202, { ok: true });
    case 'update':
      return sendJson(res, 202, { ok: true, id: host.startUpdate(name).id });
    case 'rollback':
      host.rollback(name);
      return sendJson(res, 202, { ok: true });
    case 'remove':
      await host.removeServer(name, { keepSettings: body.keepSettings !== false, keepData: body.keepData !== false });
      return sendJson(res, 200, { ok: true });
    default:
      return fail(res, 404, 'unknown action');
  }
}

async function handle(req, res) {
  // Only Home Assistant's ingress proxy may reach the panel; other add-ons on the network may not.
  if (!TRUST_ALL && peerOf(req) !== SUPERVISOR_IP) return fail(res, 403, 'the panel is only available through Home Assistant');
  const url = new URL(req.url || '/', 'http://x');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';
  if (method !== 'GET' && !isJson(req)) return fail(res, 415, 'content-type must be application/json');

  let m;
  if (route === '/status.json') return sendJson(res, 200, { servers: host.snapshots(), incidents: recentIncidents(50) });
  if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(route))) {
    const job = host.jobs.get(m[1]);
    return job ? sendJson(res, 200, job) : fail(res, 404, 'no such job (it may have expired)');
  }
  if (route === '/api/servers' && method === 'POST') {
    const body = await readJsonBody(req);
    const job = host.addServer({ repo: body.repo, autoUpdate: body.autoUpdate !== false });
    return sendJson(res, 202, { ok: true, id: job.id });
  }
  if (route === '/api/host/settings' && method === 'GET') {
    if (req.headers['x-requested-with'] !== 'admin') return fail(res, 400, 'missing header');
    return sendJson(res, 200, { ok: true, values: store.host() });
  }
  if (route === '/api/host/settings' && method === 'PUT') {
    const errors = store.updateHost(await readJsonBody(req));
    return errors.length ? fail(res, 400, ...errors) : sendJson(res, 200, { ok: true, ...hostSettingsView() });
  }
  if ((m = /^\/api\/server\/([^/]+)(?:\/([a-z]+))?$/.exec(route))) {
    return serverApi(req, res, url, decodeURIComponent(m[1]), m[2] || '');
  }

  if (method !== 'GET') return fail(res, 405, 'method not allowed');
  if ((m = /^\/server\/([^/]+)$/.exec(route))) {
    const name = decodeURIComponent(m[1]);
    if (host.servers.has(name)) return send(res, 200, 'text/html', serverPage(host.detail(name), layout(req, `server:${name}`)));
    return send(res, 404, 'text/html', overviewPage(host.snapshots(), recentIncidents(15), { ...layout(req, ''), notice: `No server named "${name}".` }));
  }
  if (route === '/add') return send(res, 200, 'text/html', addPage(layout(req, 'add')));
  if (route === '/host') return send(res, 200, 'text/html', hostPage(hostView(), layout(req, 'host')));
  if (route === '/') return send(res, 200, 'text/html', overviewPage(host.snapshots(), recentIncidents(15), layout(req, '')));
  return fail(res, 404, 'not found');
}

const panel = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!err.status) log('host', `panel error: ${err.stack || err}`);
    if (!res.headersSent) fail(res, err.status || 500, err.message);
    else res.end();
  });
});

// ---- router ----------------------------------------------------------------

const router = createRouter({
  resolve: host.resolve,
  hostHealth: async () => host.hostHealth(),
  onError: (name, err) => log(name, `proxy error: ${err.code || err.message}`),
});

// ---- main ------------------------------------------------------------------

let stopping = false;
async function every(intervalMs, label, fn, firstDelayMs = intervalMs) {
  for (let wait = firstDelayMs; !stopping; wait = intervalMs) {
    await sleep(wait);
    if (stopping) return;
    await fn().catch((err) => log('host', `${label} error: ${err.stack || err}`));
  }
}

async function main() {
  await resolveSelf();
  log('host', `HA Server Host ${self.version} on Node ${process.versions.node}`);
  panel.listen(PANEL_PORT, '0.0.0.0', () => log('host', `panel on :${PANEL_PORT} (ingress)`));
  router.listen(ROUTER_PORT, '0.0.0.0', () => log('host', `routing public traffic on :${ROUTER_PORT}`));
  await host.boot();
  every(CHECK_INTERVAL_MS, 'health check', host.tick);
  // The first update check waits a few minutes so it does not stack on a host restart.
  every(UPDATE_INTERVAL_MS, 'update check', host.checkUpdates, Math.min(UPDATE_INTERVAL_MS, 3 * 60_000));
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log('host', `${sig}: stopping every server`);
    setTimeout(() => process.exit(0), 20_000).unref();
    await host.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
