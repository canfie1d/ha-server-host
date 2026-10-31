// One hosted server: its process, its health and its restart policy. Each server runs as its own
// process group with only its own environment, so one server's crash, settings or logs never
// reach another.
//
// Health model (the same on every server):
//   heartbeat  is the process alive. Failing it repeatedly gets the server restarted.
//   health     is it usable (auth, upstream, data). Failing it raises an alert but never a
//              restart, since a restart cannot fix an expired credential or a down upstream.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA, LOGS, incident, log, sleep } from './util.mjs';
import { HOST_SETTING_GROUPS, RESERVED_ENV } from './manifest.mjs';
import { readManifest } from './bundles.mjs';

const HEARTBEAT_FAILS_BEFORE_RESTART = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASHES_BEFORE_GIVING_UP = 5;
const GIVE_UP_COOLDOWN_MS = 30 * 60_000;
const CRASH_NOTIFY_EVERY_MS = 10 * 60_000;
const ATTENTION_RENOTIFY_MS = 12 * 60 * 60_000;
const STOP_GRACE_MS = 10_000;
const TAIL_LINES = 1000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
// Terminal colour and cursor codes, which render as boxes on the server page.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const SERVER_DATA = path.join(DATA, 'server-data');

export const STATUS_LABEL = {
  healthy: 'healthy',
  attention: 'needs attention',
  starting: 'starting',
  down: 'down',
  failed: 'failed',
  stopped: 'stopped',
  'needs-settings': 'needs settings',
  broken: 'no bundle',
  busy: 'working',
};

async function probe(port, p, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'ha-server-host' } });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, body };
}

export class ManagedServer {
  /**
   * rec: this server's registry record (persisted by the host, mutated in place).
   * ctx: { settings(name), hostSettings(), notify(key, title, msg), dismiss(key), saveRegistry() }
   */
  constructor(rec, ctx) {
    this.rec = rec;
    this.ctx = ctx;
    this.dataDir = path.join(SERVER_DATA, rec.name);
    this.child = null;
    this.tail = [];
    this.phase = 'stopped'; // stopped | starting | running | failed
    this.alive = null; // last heartbeat answered
    this.usable = null; // last health passed
    this.detail = '';
    this.heartbeatFails = 0;
    this.crashes = [];
    this.retryAt = 0;
    this.restartTimer = null;
    this.lastCrashNotice = 0;
    this.attentionAt = 0;
    this.busy = ''; // a host operation in progress (update, rollback, restart); pauses supervision
    this.lastExit = null;
    this.loadBundle();
  }

  get name() {
    return this.rec.name;
  }

  loadBundle() {
    this.bundleError = null;
    this.manifest = null;
    this.dir = this.rec.current?.dir || null;
    if (!this.dir) {
      this.bundleError = 'no release installed';
      return;
    }
    try {
      this.manifest = readManifest(this.dir);
    } catch (err) {
      this.bundleError = existsSync(this.dir) ? err.message : `bundle directory ${this.dir} is missing`;
    }
  }

  /** Point at a different extracted bundle (used by updates and rollbacks). */
  useBundle(dir, manifest) {
    this.dir = dir;
    this.manifest = manifest;
    this.bundleError = null;
  }

  /** Add output to the log tail as one timestamped line per line of text. */
  record(text) {
    const at = new Date().toISOString();
    const lines = String(text).replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;
    this.tail.push(...lines.map((l) => `${at} ${l}`));
    if (this.tail.length > TAIL_LINES) this.tail = this.tail.slice(-TAIL_LINES);
  }

  /** A host message about this server: goes to the add-on log and to the server's own log. */
  note(msg) {
    log(this.name, msg);
    this.record(`[host] ${msg}`);
  }

  // ---- settings and environment -----------------------------------------

  fields() {
    return this.manifest?.settings || [];
  }

  missing() {
    const s = this.ctx.settings(this.name);
    return this.fields().filter((f) => f.required && !f.default && !s[f.env] && !f.aliases.some((a) => s[a])).map((f) => f.env);
  }

  publicUrl() {
    const h = this.rec.hostnames?.[0];
    return h ? `https://${h}` : '';
  }

  env() {
    const m = this.manifest;
    const fill = (v) => String(v).replaceAll('{{bundle}}', this.dir).replaceAll('{{data}}', this.dataDir);
    const env = { PATH: process.env.PATH, HOME: this.dataDir };
    if (process.env.TZ) env.TZ = process.env.TZ;
    for (const [k, v] of Object.entries(m.env)) env[k] = fill(v);
    const host = this.ctx.hostSettings();
    for (const group of m.hostSettings) {
      for (const [k, hostKey] of Object.entries(HOST_SETTING_GROUPS[group])) if (host[hostKey]) env[k] = host[hostKey];
    }
    if (this.publicUrl()) env.PUBLIC_URL = this.publicUrl();
    for (const f of this.fields()) if (f.default) env[f.env] = fill(f.default);
    for (const [k, v] of Object.entries(this.ctx.settings(this.name))) if (!RESERVED_ENV.has(k)) env[k] = v;
    return { ...env, NODE_ENV: 'production', PORT: String(this.rec.port), HOST: '127.0.0.1', DATA_DIR: this.dataDir };
  }

  // ---- process -----------------------------------------------------------

  canRun() {
    return !this.bundleError && this.rec.enabled && !this.missing().length;
  }

  logStream() {
    const file = path.join(LOGS, `${this.name}.log`);
    try {
      if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {}
    const out = createWriteStream(file, { flags: 'a' });
    out.on('error', (err) => log(this.name, `log file: ${err.message}`));
    return out;
  }

  /** Spawn the process. Returns false when it cannot run (stopped, missing settings, no bundle). */
  spawn() {
    if (this.child) return true;
    if (!this.canRun()) return false;
    mkdirSync(this.dataDir, { recursive: true });
    const start = this.manifest.start;
    const [file, args] = Array.isArray(start)
      ? [start[0] === 'node' ? process.execPath : start[0], start.slice(1)]
      : ['sh', ['-c', `exec ${start}`]];
    const out = this.logStream();
    // detached: the server leads its own process group, so stop() also ends anything it spawned.
    const child = spawn(file, args, { cwd: this.dir, env: this.env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = () => {
      let rest = ''; // chunks can end mid-line; hold the partial line so each line gets one timestamp
      const write = (d) => {
        out.write(d);
        const parts = (rest + String(d)).split('\n');
        rest = parts.pop();
        if (parts.length) this.record(parts.join('\n'));
      };
      write.flush = () => {
        if (rest) this.record(rest);
        rest = '';
      };
      return write;
    };
    const stdout = sink();
    const stderr = sink();
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    let ended = false;
    const onEnd = (code, signal) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      this.lastExit = { code, signal, at: Date.now() };
      this.alive = false;
      if (child.stopping) return;
      this.note(`process exited unexpectedly (${signal || `code ${code}`})`);
      this.crashes = [...this.crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS), Date.now()];
      // While a host operation runs it decides what happens next; otherwise recover now.
      if (!this.busy) this.recover();
    };
    child.on('exit', onEnd);
    // Output can still arrive after 'exit'; the log file closes once the pipes do.
    child.on('close', () => {
      stdout.flush();
      stderr.flush();
      out.end();
    });
    child.on('error', (err) => {
      this.note(`process error: ${err.message}`);
      if (child.pid === undefined) onEnd(127, null); // never started, so no exit event follows
    });
    this.child = child;
    this.phase = 'starting';
    this.startedAt = Date.now();
    this.alive = null;
    this.usable = null;
    this.heartbeatFails = 0;
    this.note(`started ${this.manifest.version || path.basename(this.dir)} on port ${this.rec.port}${child.pid ? ` (pid ${child.pid})` : ''}`);
    return true;
  }

  signal(child, sig) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  }

  /** Stop the process group: SIGTERM, then SIGKILL after a grace period. Resolves once it exited. */
  async stop() {
    const child = this.child;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.phase = 'stopped';
    this.alive = null;
    this.usable = null;
    if (!child) return;
    child.stopping = true;
    this.child = null;
    const exited = new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
    this.signal(child, 'SIGTERM');
    const timer = setTimeout(() => this.signal(child, 'SIGKILL'), STOP_GRACE_MS);
    await Promise.race([exited, sleep(STOP_GRACE_MS + 5000)]);
    clearTimeout(timer);
    // The group leader is gone; make sure nothing it started is left holding the port.
    this.signal(child, 'SIGKILL');
  }

  /**
   * Start and wait until the heartbeat answers (and, with requireHealth, the health check
   * passes). Returns { ok, detail }.
   */
  async start({ requireHealth = false } = {}) {
    if (!this.spawn()) return { ok: false, detail: this.blockedReason() };
    const r = await this.waitReady({ requireHealth });
    if (this.child) this.phase = 'running';
    this.detail = r.detail;
    return r;
  }

  async waitReady({ requireHealth }) {
    const until = Date.now() + this.manifest.health.startupSeconds * 1000;
    let last = 'no answer yet';
    while (Date.now() < until) {
      await sleep(1500);
      if (!this.child) {
        const e = this.lastExit;
        return { ok: false, detail: `process exited during startup (${e?.signal || `code ${e?.code}`})` };
      }
      const hb = await this.heartbeat();
      if (!hb.ok) {
        last = hb.detail;
        continue;
      }
      this.alive = true;
      const h = await this.health();
      this.usable = h.ok;
      if (h.ok || !requireHealth) return { ok: true, detail: h.detail };
      last = h.detail;
    }
    return { ok: false, detail: `not ready after ${this.manifest.health.startupSeconds}s: ${last}` };
  }

  async restart(reason) {
    this.note(`restarting${reason ? `: ${reason}` : ''}`);
    await this.stop();
    return this.start();
  }

  blockedReason() {
    if (this.bundleError) return this.bundleError;
    if (!this.rec.enabled) return 'stopped';
    const missing = this.missing();
    if (missing.length) return `missing settings: ${missing.join(', ')}`;
    return '';
  }

  // ---- health ------------------------------------------------------------

  async heartbeat() {
    const p = this.manifest.health.heartbeat;
    try {
      const r = await probe(this.rec.port, p, 5000);
      return r.ok ? { ok: true, detail: 'alive' } : { ok: false, detail: `${p} returned ${r.status}` };
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
      return { ok: false, detail: `${p} unreachable: ${why}` };
    }
  }

  async health() {
    const p = this.manifest.health.health;
    try {
      const r = await probe(this.rec.port, p, 15_000);
      if (r.ok) return { ok: true, detail: 'healthy' };
      const failing = Object.entries(r.body?.checks || {}).filter(([, v]) => v === false || v?.ok === false).map(([k]) => k);
      const why = failing.length ? `failing: ${failing.join(', ')}` : r.body?.detail || r.body?.error || `returned ${r.status}`;
      return { ok: false, detail: `${p} ${why}` };
    } catch (err) {
      return { ok: false, detail: `${p} did not answer: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` };
    }
  }

  /** Called on every health interval by the host. */
  async tick() {
    if (this.busy || !this.canRun()) return;
    if (this.phase === 'failed') {
      if (Date.now() < this.retryAt) return;
      this.crashes = [];
      this.busy = 'restarting';
      try {
        const r = await this.restart('trying again after the cool-off');
        if (r.ok) await this.ctx.notify(this.name, `${this.title()} is back`, `${this.title()} is running again after it was down.`);
      } finally {
        this.busy = '';
      }
      return;
    }
    // The process died while a host operation was running, which left recovery to us.
    if (!this.child && !this.restartTimer && (this.phase === 'starting' || this.phase === 'running')) return this.recover();
    if (this.phase !== 'running') return;

    const hb = await this.heartbeat();
    if (!hb.ok) {
      this.alive = false;
      this.heartbeatFails++;
      this.detail = hb.detail;
      if (this.heartbeatFails < HEARTBEAT_FAILS_BEFORE_RESTART) return;
      const why = `heartbeat failed ${this.heartbeatFails} times in a row (${hb.detail})`;
      incident({ server: this.name, failure: why, action: 'restart' });
      this.busy = 'restarting';
      try {
        const r = await this.restart(why);
        await this.ctx.notify(
          this.name,
          `${this.title()} restarted`,
          `${this.title()} stopped answering, so the host restarted it.\nCause: ${hb.detail}\n${r.ok ? 'It is answering again.' : `It is still not answering: ${r.detail}`}`,
        );
      } finally {
        this.busy = '';
      }
      return;
    }
    this.alive = true;
    this.heartbeatFails = 0;
    await this.checkUsable();
  }

  async checkUsable() {
    const h = await this.health();
    const was = this.usable;
    this.usable = h.ok;
    this.detail = h.detail;
    if (h.ok) {
      if (this.attentionAt) {
        this.attentionAt = 0;
        this.ctx.dismiss(this.name);
        this.note('health check passing again');
      }
      return;
    }
    if (was !== false) this.note(`health check failing: ${h.detail}`);
    if (Date.now() - this.attentionAt >= ATTENTION_RENOTIFY_MS) {
      this.attentionAt = Date.now();
      incident({ server: this.name, failure: h.detail, action: 'alert' });
      await this.ctx.notify(this.name, `${this.title()} needs attention`, `${this.title()} is running but its health check fails: ${h.detail}\nA restart will not fix this, so the host has not restarted it.`);
    }
  }

  /** After an unexpected exit: restart with backoff, or give up for a while after a crash loop. */
  recover() {
    const now = Date.now();
    const crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS).length;
    const e = this.lastExit || {};
    const how = e.signal || `code ${e.code}`;
    if (crashes >= CRASHES_BEFORE_GIVING_UP) {
      this.phase = 'failed';
      this.retryAt = now + GIVE_UP_COOLDOWN_MS;
      this.detail = `exited ${crashes} times in 10 minutes; trying again at ${new Date(this.retryAt).toISOString()}`;
      incident({ server: this.name, failure: `crash loop (last exit ${how})`, action: 'gave up for 30 minutes' });
      this.ctx.notify(this.name, `${this.title()} is down`, `${this.title()} keeps exiting (${crashes} times in 10 minutes, last ${how}). The host will try again in 30 minutes. Its log is on its page in the Server Host panel.`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, crashes - 1));
    this.phase = 'starting';
    this.detail = `exited (${how}); restarting in ${Math.round(delay / 1000)}s`;
    if (now - this.lastCrashNotice >= CRASH_NOTIFY_EVERY_MS) {
      this.lastCrashNotice = now;
      incident({ server: this.name, failure: `exited (${how})`, action: 'restart' });
      this.ctx.notify(this.name, `${this.title()} restarted`, `${this.title()} exited unexpectedly (${how}) and was restarted.`);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.child || this.busy || this.phase === 'failed' || !this.canRun()) return;
      this.start().catch((err) => this.note(`restart failed: ${err.message}`));
    }, delay);
    this.restartTimer.unref?.();
  }

  // ---- reporting ---------------------------------------------------------

  title() {
    return this.manifest?.displayName || this.name;
  }

  status() {
    if (this.busy) return 'busy';
    if (this.bundleError) return 'broken';
    if (!this.rec.enabled) return 'stopped';
    if (this.missing().length) return 'needs-settings';
    if (this.phase === 'failed') return 'failed';
    if (this.phase === 'starting') return 'starting';
    if (this.phase === 'stopped') return 'stopped';
    if (this.alive === false) return 'down';
    if (this.usable === false) return 'attention';
    if (this.alive === null) return 'starting';
    return 'healthy';
  }

  statusDetail() {
    if (this.busy) return `${this.busy} in progress`;
    const blocked = this.blockedReason();
    if (blocked && blocked !== 'stopped') return blocked;
    return this.detail;
  }

  snapshot() {
    return {
      name: this.name,
      title: this.title(),
      description: this.manifest?.description || '',
      status: this.status(),
      detail: this.statusDetail(),
      busy: this.busy,
      version: this.rec.current?.version || null,
      tag: this.rec.current?.tag || null,
      hostnames: this.rec.hostnames || [],
      port: this.rec.port,
    };
  }
}
