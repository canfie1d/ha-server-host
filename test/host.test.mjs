// End to end: a fake GitHub API serves real bundles, and the host runs as its own process.
// Covers add, settings, routing by hostname, a failed update with automatic rollback, a good
// update, manual rollback, crash recovery without touching the other server, and remove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'ha-server-host-test-'));
const DATA = path.join(work, 'data');
const TOKEN = 'test-github-token';

const SERVER_JS = `
import http from 'node:http';
const mode = process.env.MODE || 'good';
if (mode === 'crash') setTimeout(() => process.exit(3), 200);
let broken = false, sick = mode === 'bad-health';
http.createServer((req, res) => {
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.url === '/heartbeat') return broken ? send(500, { status: 'broken' }) : send(200, { status: 'ok' });
  if (req.url === '/health') return sick ? send(503, { status: 'failing', checks: { database: false } }) : send(200, { status: 'ok' });
  if (req.url === '/break') { broken = true; return send(200, {}); }
  if (req.url === '/sick') { sick = !sick; return send(200, { sick }); }
  if (req.url === '/pid') return send(200, { pid: process.pid });
  if (req.url === '/whoami') return send(200, {
    host: req.headers.host, publicUrl: process.env.PUBLIC_URL, secret: process.env.DEMO_SECRET || null,
    dataDir: process.env.DATA_DIR, version: process.env.VERSION, supervisorToken: process.env.SUPERVISOR_TOKEN || null,
    githubToken: process.env.GITHUB_TOKEN || null, turso: process.env.TURSO_DATABASE_URL || null,
  });
  send(404, { error: 'not found' });
}).listen(Number(process.env.PORT), process.env.HOST);
`;

// ---- bundles and the fake GitHub API -----------------------------------------

const releases = {}; // repo -> { tag, file }
const assets = new Map(); // id -> { file, name }
let nextAsset = 1;
const sawAuthOnStorage = [];

function makeBundle(name, tag, { mode = 'good', required = true } = {}) {
  const dir = path.join(work, 'src', `${name}-${tag}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'server.mjs'), SERVER_JS);
  writeFileSync(path.join(dir, 'ha-server.json'), JSON.stringify({
    manifestVersion: 1,
    name,
    displayName: name[0].toUpperCase() + name.slice(1),
    version: tag.replace(/^v/, ''),
    start: ['node', 'server.mjs'],
    port: 9300,
    env: { MODE: mode, VERSION: tag },
    health: { heartbeat: '/heartbeat', health: '/health', startupSeconds: 8 },
    mcp: { path: '/mcp' },
    hostnames: [`${name}.example.com`],
    hostSettings: ['turso'],
    settings: required
      ? [
          { env: 'DEMO_SECRET', label: 'Demo secret', secret: true, required: true },
          { env: 'DEMO_URL', label: 'Demo URL', required: true, aliases: ['OLD_DEMO_URL'] },
        ]
      : [],
  }));
  const file = path.join(work, 'dist', `${name}-${tag}.tar.gz`);
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('tar', ['-czf', file, '-C', dir, '.']);
  return file;
}

function publish(repo, tag, file) {
  const id = nextAsset++;
  assets.set(id, { file, name: 'bundle-linux-x64.tar.gz' });
  const sumId = nextAsset++;
  const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
  assets.set(sumId, { text: `${sum}  bundle-linux-x64.tar.gz\n`, name: 'bundle-linux-x64.tar.gz.sha256' });
  releases[repo] = { tag, id, sumId, size: readFileSync(file).length };
}

let api, storage, apiPort, storagePort;
function startFakeGitHub() {
  // Asset downloads redirect to a different origin, like GitHub's storage.
  storage = http.createServer((req, res) => {
    sawAuthOnStorage.push(!!req.headers.authorization);
    const a = assets.get(Number(req.url.split('/').pop()));
    if (!a) return res.writeHead(404).end();
    res.writeHead(200);
    res.end(a.file ? readFileSync(a.file) : a.text);
  });
  api = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(404).end('{}');
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(req.url))) {
      const r = releases[m[1]];
      if (!r) return res.writeHead(404).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: r.tag,
        name: r.tag,
        published_at: new Date().toISOString(),
        assets: [
          { name: 'bundle-linux-x64.tar.gz', size: r.size, url: `http://127.0.0.1:${apiPort}/assets/${r.id}` },
          { name: 'bundle-linux-x64.tar.gz.sha256', size: 90, url: `http://127.0.0.1:${apiPort}/assets/${r.sumId}` },
        ],
      }));
    }
    if ((m = /^\/assets\/(\d+)$/.exec(req.url))) {
      res.writeHead(302, { location: `http://localhost:${storagePort}/blob/${m[1]}` });
      return res.end();
    }
    res.writeHead(404).end('{}');
  });
  return Promise.all([
    new Promise((r) => api.listen(0, '127.0.0.1', () => r((apiPort = api.address().port)))),
    new Promise((r) => storage.listen(0, '127.0.0.1', () => r((storagePort = storage.address().port)))),
  ]);
}

// ---- the host under test ---------------------------------------------------

let hostProc;
let hostLog = '';
const PANEL = 18100 + Math.floor(Math.random() * 500);
const ROUTER = PANEL + 1000;

function startHost() {
  hostProc = spawn(process.execPath, [path.join(ROOT, 'src/index.mjs')], {
    env: {
      PATH: process.env.PATH,
      DATA_DIR: DATA,
      HOST_TRUST_ALL: '1',
      HOST_PANEL_PORT: String(PANEL),
      HOST_ROUTER_PORT: String(ROUTER),
      HOST_GITHUB_API: `http://127.0.0.1:${apiPort}`,
      HOST_CHECK_INTERVAL_MS: '1000',
      HOST_UPDATE_INTERVAL_MS: String(60 * 60_000),
      SUPERVISOR_TOKEN: '',
      GITHUB_TOKEN: 'must-not-leak',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostProc.stdout.on('data', (d) => (hostLog += d));
  hostProc.stderr.on('data', (d) => (hostLog += d));
}

async function panel(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PANEL}/${p}`, {
    method,
    headers: body === undefined ? { 'x-requested-with': 'admin' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function routed(hostname, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ROUTER, path: p, headers: { host: hostname } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(what, fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => e);
    if (last === true || (last && last.ok === true)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(last)}\n--- host log ---\n${hostLog.slice(-4000)}`);
}

async function job(id) {
  let j;
  await until('job', async () => {
    j = (await panel('GET', `api/jobs/${id}`)).json;
    return j.state !== 'running';
  }, 60_000);
  return j;
}

const statusOf = async (name) => (await panel('GET', `api/server/${name}`)).json;

before(async () => {
  await startFakeGitHub();
  publish('example/demo', 'v1.0.0', makeBundle('demo', 'v1.0.0'));
  publish('example/other', 'v2.0.0', makeBundle('other', 'v2.0.0', { required: false }));
  startHost();
  await until('panel', async () => (await panel('GET', 'status.json')).status === 200);
});

after(async () => {
  hostProc?.kill('SIGTERM');
  await new Promise((r) => (hostProc ? hostProc.once('exit', r) : r()));
  api?.close();
  storage?.close();
  rmSync(work, { recursive: true, force: true });
});

test('a private repo needs the GitHub token', async () => {
  const r = await panel('POST', 'api/servers', { repo: 'example/demo' });
  assert.equal(r.status, 202);
  const j = await job(r.json.id);
  assert.equal(j.state, 'error');
  assert.match(j.error, /GitHub token/);
});

test('host settings save, and secrets stay hidden from plain reads', async () => {
  const r = await panel('PUT', 'api/host/settings', { set: { github_token: TOKEN, turso_database_url: 'libsql://shared.turso.io' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.set, ['github_token', 'turso_database_url']);
  assert.equal(r.json.plain.github_token, undefined);
  const bad = await panel('PUT', 'api/host/settings', { set: { nope: 'x' } });
  assert.equal(bad.status, 400);
});

test('add a server from its repo; it waits for required settings', async () => {
  const r = await panel('POST', 'api/servers', { repo: 'https://github.com/example/demo' });
  const j = await job(r.json.id);
  assert.equal(j.state, 'done', j.error);
  assert.deepEqual(j.result, { name: 'demo', tag: 'v1.0.0', missing: ['DEMO_SECRET', 'DEMO_URL'] });
  assert.ok(sawAuthOnStorage.length > 0 && sawAuthOnStorage.every((x) => x === false), 'token must not reach the storage host');
  const s = await statusOf('demo');
  assert.equal(s.status, 'needs-settings');
  assert.deepEqual(s.hostnames, ['demo.example.com']);
  const down = await routed('demo.example.com', '/heartbeat');
  assert.equal(down.status, 503);
  const again = await panel('POST', 'api/servers', { repo: 'example/demo' });
  assert.equal(again.status, 409);
});

test('settings apply live and the router sends the hostname to the server', async () => {
  const partial = await panel('PUT', 'api/server/demo/settings', { set: { DEMO_SECRET: 's3cret' } });
  assert.deepEqual(partial.json.missing, ['DEMO_URL']);
  assert.equal(partial.json.action, null);
  // A value under the older name satisfies the required setting.
  const r = await panel('PUT', 'api/server/demo/settings', { set: { OLD_DEMO_URL: 'https://old.example.com' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.action, 'start');
  await until('demo healthy', async () => (await statusOf('demo')).status === 'healthy');
  const who = (await routed('demo.example.com', '/whoami')).json;
  assert.equal(who.host, 'demo.example.com');
  assert.equal(who.publicUrl, 'https://demo.example.com');
  assert.equal(who.secret, 's3cret');
  assert.equal(who.version, 'v1.0.0');
  assert.equal(who.turso, 'libsql://shared.turso.io');
  assert.equal(who.githubToken, null, 'host environment must not leak to servers');
  assert.equal(who.supervisorToken, null);
  assert.ok(who.dataDir.endsWith(path.join('server-data', 'demo')));
  const reserved = await panel('PUT', 'api/server/demo/settings', { set: { PORT: '1' } });
  assert.equal(reserved.status, 400);
  const values = await panel('GET', 'api/server/demo/settings');
  assert.equal(values.json.values.DEMO_SECRET, 's3cret');
});

test('a second server runs alongside on its own hostname and port', async () => {
  const j = await job((await panel('POST', 'api/servers', { repo: 'example/other' })).json.id);
  assert.equal(j.state, 'done', j.error);
  await until('other healthy', async () => (await statusOf('other')).status === 'healthy');
  const [a, b] = await Promise.all([statusOf('demo'), statusOf('other')]);
  assert.notEqual(a.port, b.port);
  assert.equal((await routed('other.example.com', '/whoami')).json.secret, null);
  assert.equal((await routed('nobody.example.com', '/whoami')).status, 404);
  const hb = await routed('ha-host.local', '/heartbeat');
  assert.equal(hb.status, 200);
  const health = await routed('ha-host.local', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
});

test('hostnames are editable and unique across servers', async () => {
  const clash = await panel('PUT', 'api/server/other/hostnames', { hostnames: ['demo.example.com'] });
  assert.equal(clash.status, 400);
  const ok = await panel('PUT', 'api/server/other/hostnames', { hostnames: ['Other.Example.com', 'alt.example.com'] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.hostnames, ['other.example.com', 'alt.example.com']);
  assert.equal((await routed('alt.example.com', '/heartbeat')).status, 200);
});

test('an update that fails its health check is rolled back automatically', async () => {
  const otherPid = (await routed('other.example.com', '/pid')).json.pid;
  publish('example/demo', 'v1.1.0', makeBundle('demo', 'v1.1.0', { mode: 'bad-health' }));
  const j = await job((await panel('POST', 'api/server/demo/update', {})).json.id);
  assert.equal(j.state, 'done', j.error);
  assert.equal(j.result.reverted, true);
  const s = await statusOf('demo');
  assert.equal(s.current.tag, 'v1.0.0');
  assert.equal(s.rejected, 'v1.1.0');
  await until('demo healthy after revert', async () => (await statusOf('demo')).status === 'healthy');
  assert.equal((await routed('demo.example.com', '/whoami')).json.version, 'v1.0.0');
  assert.equal((await routed('other.example.com', '/pid')).json.pid, otherPid, 'the other server must not restart');
  assert.match(hostLog, /Demo update failed/);
});

test('a good update installs and keeps the previous release for rollback', async () => {
  publish('example/demo', 'v1.2.0', makeBundle('demo', 'v1.2.0'));
  const j = await job((await panel('POST', 'api/server/demo/update', {})).json.id);
  assert.equal(j.result.updated, true, JSON.stringify(j));
  const s = await statusOf('demo');
  assert.equal(s.current.tag, 'v1.2.0');
  assert.equal(s.previous.tag, 'v1.0.0');
  assert.equal(s.rejected, null);
  assert.equal((await routed('demo.example.com', '/whoami')).json.version, 'v1.2.0');
  const same = await job((await panel('POST', 'api/server/demo/update', {})).json.id);
  assert.equal(same.result.updated, false);
});

test('manual rollback goes back to the previous release', async () => {
  assert.equal((await panel('POST', 'api/server/demo/rollback', {})).status, 202);
  await until('rolled back', async () => {
    const s = await statusOf('demo');
    return s.current.tag === 'v1.0.0' && s.status === 'healthy';
  });
  assert.equal((await routed('demo.example.com', '/whoami')).json.version, 'v1.0.0');
  assert.equal((await statusOf('demo')).rejected, 'v1.2.0');
});

test('a crashed server is restarted and the other server is untouched', async () => {
  const otherPid = (await routed('other.example.com', '/pid')).json.pid;
  const pid = (await routed('demo.example.com', '/pid')).json.pid;
  process.kill(pid, 'SIGKILL');
  await until('demo back with a new pid', async () => {
    const r = await routed('demo.example.com', '/pid');
    return r.status === 200 && r.json.pid !== pid;
  });
  assert.equal((await routed('other.example.com', '/pid')).json.pid, otherPid);
  assert.match(hostLog, /Demo restarted/);
});

test('a failing health check alerts but never restarts', async () => {
  const pid = (await routed('other.example.com', '/pid')).json.pid;
  await routed('other.example.com', '/sick');
  await until('other needs attention', async () => (await statusOf('other')).status === 'attention');
  assert.match((await statusOf('other')).detail, /failing: database/);
  assert.match(hostLog, /Other needs attention/);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal((await routed('other.example.com', '/pid')).json.pid, pid, 'health failures must not restart the server');
  await routed('other.example.com', '/sick');
  await until('other healthy again', async () => (await statusOf('other')).status === 'healthy');
});

test('repeated heartbeat failures restart the server', async () => {
  const pid = (await routed('other.example.com', '/pid')).json.pid;
  const demoPid = (await routed('demo.example.com', '/pid')).json.pid;
  await routed('other.example.com', '/break');
  await until('other restarted', async () => {
    const r = await routed('other.example.com', '/pid');
    return r.status === 200 && r.json.pid !== pid;
  });
  await until('other healthy', async () => (await statusOf('other')).status === 'healthy');
  assert.match(hostLog, /Other restarted: Other stopped answering/);
  assert.equal((await routed('demo.example.com', '/pid')).json.pid, demoPid);
});

test('a crash loop gives up for a while and says so', async () => {
  publish('canfie1d/crashy', 'v0.1.0', makeBundle('crashy', 'v0.1.0', { mode: 'crash', required: false }));
  const j = await job((await panel('POST', 'api/servers', { repo: 'canfie1d/crashy' })).json.id);
  assert.equal(j.state, 'done', j.error);
  await until('crashy failed', async () => (await statusOf('crashy')).status === 'failed', 60_000);
  assert.match((await statusOf('crashy')).detail, /exited 5 times in 10 minutes/);
  assert.match(hostLog, /Crashy is down/);
  assert.equal((await statusOf('demo')).status, 'healthy');
  assert.equal((await panel('POST', 'api/server/crashy/remove', {})).status, 200);
});

test('stop and start one server', async () => {
  assert.equal((await panel('POST', 'api/server/other/stop', {})).status, 200);
  assert.equal((await statusOf('other')).status, 'stopped');
  assert.equal((await routed('other.example.com', '/heartbeat')).status, 503);
  assert.equal((await routed('demo.example.com', '/heartbeat')).status, 200);
  assert.equal((await panel('POST', 'api/server/other/start', {})).status, 202);
  await until('other healthy again', async () => (await statusOf('other')).status === 'healthy');
});

test('the panel pages render', async () => {
  for (const p of ['', 'server/demo', 'add', 'host']) {
    const r = await panel('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<!doctype html>/);
    assert.doesNotMatch(r.text, /s3cret|test-github-token/, `${p} must not include secret values`);
  }
});

test('remove a server, deleting its settings and data', async () => {
  const r = await panel('POST', 'api/server/demo/remove', { keepSettings: false, keepData: false });
  assert.equal(r.status, 200, r.text);
  assert.equal((await panel('GET', 'api/server/demo')).status, 404);
  // The hostname is unknown now, so only the host's own endpoints answer on it.
  assert.equal((await routed('demo.example.com', '/whoami')).status, 404);
  assert.ok(!existsSync(path.join(DATA, 'bundles/demo')));
  assert.ok(!existsSync(path.join(DATA, 'server-data/demo')));
  const settings = JSON.parse(readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  assert.equal(settings.demo, undefined);
  assert.equal((await statusOf('other')).status, 'healthy');
});
