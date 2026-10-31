// The set of hosted servers and every operation on them: add, remove, update with automatic
// rollback, settings, hostnames and imports. Each operation runs on one server at a time and
// never stops or restarts any other server.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOGS, incident, log, recentIncidents, sleep, validateEnvEdit } from './util.mjs';
import { latestRelease, parseRepo } from './github.mjs';
import { installBundle, pruneBundles, readManifest, removeBundles } from './bundles.mjs';
import { HOSTNAME_RE, RESERVED_ENV } from './manifest.mjs';
import { ManagedServer } from './server.mjs';

const FIRST_INTERNAL_PORT = 9100;
const JOB_TTL_MS = 60 * 60_000;
const IMPORT_FORMAT = 'ha-server-host-import';

export function createHost({ store, notify, dismiss, reservedPorts = [] }) {
  const servers = new Map();
  const jobs = new Map();
  const lastUpdateError = new Map();
  const ctx = {
    settings: (name) => store.settings(name),
    hostSettings: () => store.host(),
    notify,
    dismiss,
  };
  const token = () => store.host().github_token || process.env.GITHUB_TOKEN || '';
  const get = (name) => {
    const s = servers.get(name);
    if (!s) throw Object.assign(new Error(`no server named "${name}"`), { status: 404 });
    return s;
  };
  const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
  const save = () => store.saveRegistry();

  /** Wait for an operation in progress (a restart, an update) to finish. */
  async function waitIdle(s, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (s.busy && Date.now() < end) await sleep(250);
    if (s.busy) throw conflict(`${s.name} is busy: ${s.busy}`);
  }

  /** Run fn(progress) in the background as a job the panel can poll. */
  function job(label, fn) {
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(id);
    const j = { id: randomUUID(), label, state: 'running', progress: '', result: null, error: null, startedAt: now };
    jobs.set(j.id, j);
    fn((msg) => (j.progress = msg))
      .then((result) => Object.assign(j, { state: 'done', result }))
      .catch((err) => {
        log('host', `${label} failed: ${err.message}`);
        Object.assign(j, { state: 'error', error: err.message });
      });
    return j;
  }

  /** Run a server operation in the background, marked busy so health checks sit it out. */
  function background(s, label, fn) {
    if (s.busy) throw conflict(`${s.name} is busy: ${s.busy}`);
    s.busy = label;
    (async () => {
      try {
        await fn();
      } catch (err) {
        s.note(`${label} failed: ${err.message}`);
      } finally {
        s.busy = '';
      }
    })();
  }

  function assignPort(preferred) {
    const used = new Set([...reservedPorts, ...store.records().map((r) => r.port)]);
    if (preferred && !used.has(preferred)) return preferred;
    let p = FIRST_INTERNAL_PORT;
    while (used.has(p)) p++;
    return p;
  }

  function owners() {
    const map = new Map();
    for (const s of servers.values()) for (const h of s.rec.hostnames || []) map.set(h, s.name);
    return map;
  }

  // ---- lifecycle ---------------------------------------------------------

  async function boot() {
    for (const rec of store.records()) {
      const s = new ManagedServer(rec, ctx);
      servers.set(rec.name, s);
      if (s.bundleError) s.note(`cannot start: ${s.bundleError}`);
    }
    log('host', `managing ${servers.size} server(s)`);
    await Promise.allSettled(
      [...servers.values()].map(async (s) => {
        if (!s.canRun()) return;
        const r = await s.start();
        if (!r.ok) s.note(`not answering after start: ${r.detail}`);
      }),
    );
  }

  async function shutdown() {
    await Promise.allSettled([...servers.values()].map((s) => s.stop()));
  }

  async function tick() {
    await Promise.allSettled([...servers.values()].map((s) => s.tick().catch((err) => s.note(`health check error: ${err.message}`))));
  }

  // ---- add and remove ----------------------------------------------------

  function addServer({ repo: input, autoUpdate = true }) {
    const repo = parseRepo(input);
    const existing = store.records().find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (existing) throw conflict(`${repo} is already added as ${existing.name}`);
    return job(`add ${repo}`, async (progress) => {
      progress('looking up the latest release');
      const release = await latestRelease(repo, token());
      const bundle = await installBundle(release, token(), {
        onProgress: progress,
        accept: (m) => {
          if (servers.has(m.name)) throw conflict(`a server named "${m.name}" is already added`);
        },
      });
      const { manifest } = bundle;
      const taken = owners();
      const rec = {
        name: manifest.name,
        repo,
        autoUpdate: !!autoUpdate,
        enabled: true,
        hostnames: manifest.hostnames.filter((h) => !taken.has(h)),
        port: assignPort(manifest.port),
        current: { tag: bundle.tag, version: bundle.version, dir: bundle.dir, installedAt: new Date().toISOString() },
        previous: null,
        rejected: null,
        addedAt: new Date().toISOString(),
      };
      store.putRecord(rec);
      const s = new ManagedServer(rec, ctx);
      servers.set(rec.name, s);
      s.note(`added from ${repo} ${bundle.tag}`);
      incident({ server: rec.name, action: `added ${bundle.tag}` });
      const skipped = manifest.hostnames.filter((h) => taken.has(h));
      if (skipped.length) s.note(`hostnames already used by another server, not assigned: ${skipped.join(', ')}`);
      if (s.canRun()) background(s, 'starting', () => s.start());
      return { name: rec.name, tag: bundle.tag, missing: s.missing() };
    });
  }

  async function removeServer(name, { keepSettings = true, keepData = true } = {}) {
    const s = get(name);
    await waitIdle(s);
    s.busy = 'removing';
    await s.stop();
    servers.delete(name);
    store.deleteRecord(name);
    removeBundles(name);
    for (const f of [`${name}.log`, `${name}.log.1`]) rmSync(path.join(LOGS, f), { force: true });
    if (!keepSettings) store.deleteSettings(name);
    if (!keepData) rmSync(s.dataDir, { recursive: true, force: true });
    dismiss(name);
    incident({ server: name, action: `removed (settings ${keepSettings ? 'kept' : 'deleted'}, data ${keepData ? 'kept' : 'deleted'})` });
    log('host', `removed ${name}`);
  }

  // ---- updates and rollback ----------------------------------------------

  /**
   * Install the latest release. The new release must pass its health check (or at least its
   * heartbeat, when health was already failing before the update); otherwise the previous
   * release is put back, the new one is not tried again automatically, and an alert goes out.
   */
  async function update(name, { manual = false, progress = () => {} } = {}) {
    const s = get(name);
    const rec = s.rec;
    progress('looking up the latest release');
    const release = await latestRelease(rec.repo, token());
    if (release.tag === rec.current?.tag && !s.bundleError) return { updated: false, message: `already on ${release.tag}` };
    if (!manual && release.tag === rec.rejected) return { updated: false, message: `${release.tag} failed its health check before; not retrying` };
    if (s.busy) throw conflict(`${name} is busy: ${s.busy}`);
    s.busy = 'updating';
    let bundle = null;
    let old = null;
    try {
      bundle = await installBundle(release, token(), {
        onProgress: progress,
        accept: (m) => {
          if (m.name !== name) throw new Error(`the release is for "${m.name}", not "${name}"`);
        },
      });
      const from = rec.current?.tag || 'nothing';
      const prior = { dir: s.dir, manifest: s.manifest, bundleError: s.bundleError };
      const settings = store.settings(name);
      const missing = bundle.manifest.settings.filter((f) => f.required && !f.default && !settings[f.env] && !f.aliases.some((a) => settings[a])).map((f) => f.env);
      if (missing.length && rec.enabled && !prior.bundleError) {
        throw new Error(`${release.tag} needs settings that are not set: ${missing.join(', ')}. Add them on the settings list, then update again.`);
      }
      const baseline = s.usable;
      progress(`switching ${from} -> ${release.tag}`);
      s.note(`updating ${from} -> ${release.tag}`);
      await s.stop();
      old = prior;
      s.useBundle(bundle.dir, bundle.manifest);
      const accepted = s.canRun() ? await s.start({ requireHealth: baseline !== false }) : { ok: true, detail: 'not started' };
      if (accepted.ok) {
        rec.previous = prior.bundleError ? rec.previous : rec.current;
        rec.current = { tag: release.tag, version: bundle.version, dir: bundle.dir, installedAt: new Date().toISOString() };
        rec.rejected = null;
        save();
        pruneBundles(name, [rec.current.dir, rec.previous?.dir]);
        s.note(`now on ${release.tag}`);
        incident({ server: name, action: `updated ${from} -> ${release.tag}` });
        return { updated: true, message: `updated to ${release.tag}` };
      }

      s.note(`${release.tag} failed its health check (${accepted.detail}); going back to ${from}`);
      await s.stop();
      rec.rejected = release.tag;
      save();
      if (prior.bundleError) s.loadBundle();
      else s.useBundle(prior.dir, prior.manifest);
      const back = s.canRun() ? await s.start() : { ok: false, detail: s.blockedReason() };
      rmSync(bundle.dir, { recursive: true, force: true });
      incident({ server: name, failure: `${release.tag}: ${accepted.detail}`, action: `reverted to ${from}` });
      await notify(
        name,
        `${s.title()} update failed`,
        `${s.title()} ${release.tag} failed its health check (${accepted.detail}), so the host went back to ${from}. ${back.ok ? 'It is running again.' : `It is not answering yet: ${back.detail}`}\nThe host will not install ${release.tag} again on its own.`,
      );
      return { updated: false, reverted: true, message: `${release.tag} failed its health check and was rolled back to ${from}: ${accepted.detail}` };
    } catch (err) {
      // Never leave the server pointing at a bundle that is about to be deleted.
      if (old && s.dir === bundle?.dir && rec.current?.dir !== bundle.dir) {
        await s.stop();
        if (old.bundleError) s.loadBundle();
        else s.useBundle(old.dir, old.manifest);
        if (s.canRun()) s.start().catch(() => {});
      }
      if (bundle && rec.current?.dir !== bundle.dir) rmSync(bundle.dir, { recursive: true, force: true });
      throw err;
    } finally {
      s.busy = '';
    }
  }

  function startUpdate(name) {
    get(name);
    return job(`update ${name}`, (progress) => update(name, { manual: true, progress }));
  }

  /** Background check for new releases of every server with automatic updates on. */
  async function checkUpdates() {
    for (const s of [...servers.values()]) {
      if (!s.rec.autoUpdate || s.busy || !servers.has(s.name)) continue;
      try {
        const r = await update(s.name);
        if (r.updated || r.reverted) log('host', `${s.name}: ${r.message}`);
        lastUpdateError.delete(s.name);
      } catch (err) {
        // Log a failing check once, not every interval.
        if (lastUpdateError.get(s.name) !== err.message) s.note(`update check failed: ${err.message}`);
        lastUpdateError.set(s.name, err.message);
      }
    }
  }

  function rollback(name) {
    const s = get(name);
    const rec = s.rec;
    const prev = rec.previous;
    if (!prev || !existsSync(prev.dir)) throw conflict('there is no previous release to go back to');
    const manifest = readManifest(prev.dir);
    background(s, 'rolling back', async () => {
      const from = rec.current?.tag;
      s.note(`rolling back ${from} -> ${prev.tag}`);
      await s.stop();
      s.useBundle(prev.dir, manifest);
      rec.previous = rec.current;
      rec.current = prev;
      rec.rejected = from || null; // a manual rollback means: do not reinstall that release on its own
      save();
      incident({ server: name, action: `rolled back ${from} -> ${prev.tag}` });
      if (s.canRun()) await s.start();
    });
  }

  // ---- run state ---------------------------------------------------------

  function start(name) {
    const s = get(name);
    s.rec.enabled = true;
    save();
    s.phase = s.phase === 'failed' ? 'stopped' : s.phase;
    if (!s.canRun()) return;
    background(s, 'starting', () => (s.child ? null : s.start()));
  }

  async function stop(name) {
    const s = get(name);
    await waitIdle(s);
    s.rec.enabled = false;
    save();
    s.note('stopped from the panel');
    await s.stop();
  }

  function restart(name) {
    const s = get(name);
    if (!s.canRun()) throw conflict(s.blockedReason() || 'cannot run');
    s.phase = s.phase === 'failed' ? 'stopped' : s.phase;
    background(s, 'restarting', () => s.restart('restart from the panel'));
  }

  /** New settings reach the process on start: restart a running server, start a waiting one. */
  function applyLive(s, why) {
    if (s.busy) return 'deferred';
    if (s.child) {
      background(s, 'restarting', () => s.restart(why));
      return 'restart';
    }
    if (s.canRun() && s.phase !== 'failed') {
      background(s, 'starting', () => s.start());
      return 'start';
    }
    return null;
  }

  function updateSettings(name, body) {
    const s = get(name);
    const errors = store.updateSettings(name, body, RESERVED_ENV);
    if (errors.length) return { ok: false, errors };
    return { ok: true, set: Object.keys(store.settings(name)).sort(), missing: s.missing(), action: applyLive(s, 'settings changed') };
  }

  function setHostnames(name, list) {
    const s = get(name);
    if (!Array.isArray(list)) return { ok: false, errors: ['"hostnames" must be an array'] };
    const clean = [...new Set(list.map((h) => String(h).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))];
    const errors = [];
    const taken = owners();
    for (const h of clean) {
      if (!HOSTNAME_RE.test(h)) errors.push(`"${h}" is not a hostname`);
      else if (taken.has(h) && taken.get(h) !== name) errors.push(`${h} already belongs to ${taken.get(h)}`);
    }
    if (errors.length) return { ok: false, errors };
    const before = s.publicUrl();
    s.rec.hostnames = clean;
    save();
    // PUBLIC_URL comes from the first hostname unless a setting overrides it.
    const action = before !== s.publicUrl() && !store.settings(name).PUBLIC_URL ? applyLive(s, 'public hostname changed') : null;
    return { ok: true, hostnames: clean, action };
  }

  function setAutoUpdate(name, on) {
    const s = get(name);
    s.rec.autoUpdate = !!on;
    save();
  }

  // ---- import ------------------------------------------------------------

  /**
   * Import settings and data files exported by the old add-ons:
   * { format: "ha-server-host-import", version: 1, source, servers: { <name>: { settings: {...},
   *   files: { "<path under the server's DATA_DIR>": "<base64>" } } } }
   * Each named server must already be added. Existing files are kept beside the new ones as
   * <file>.before-import.
   */
  function importData(payload, { dryRun = false } = {}) {
    const errors = [];
    if (!payload || payload.format !== IMPORT_FORMAT || payload.version !== 1) return { ok: false, errors: ['this is not an HA Server Host import file'] };
    const entries = Object.entries(payload.servers || {});
    if (!entries.length) return { ok: false, errors: ['the file names no servers'] };
    const plan = {};
    for (const [name, data] of entries) {
      const s = servers.get(name);
      if (!s) {
        errors.push(`add ${name} before importing its data`);
        continue;
      }
      const settings = data.settings || {};
      const usable = Object.fromEntries(Object.entries(settings).filter(([k]) => !RESERVED_ENV.has(k)));
      const current = store.settings(name);
      const files = Object.entries(data.files || {});
      for (const [rel, b64] of files) {
        const norm = path.posix.normalize(String(rel));
        if (norm.startsWith('/') || norm.startsWith('..') || norm.includes('\0')) errors.push(`${name}: file path "${rel}" is not allowed`);
        if (typeof b64 !== 'string') errors.push(`${name}: file "${rel}" must be base64 text`);
      }
      errors.push(...validateEnvEdit({ set: usable }, RESERVED_ENV).map((x) => `${name}: ${x}`));
      plan[name] = {
        settings: Object.keys(usable).sort(),
        replaces: Object.keys(usable).filter((k) => current[k] !== undefined && current[k] !== usable[k]).sort(),
        skipped: Object.keys(settings).filter((k) => RESERVED_ENV.has(k)).sort(),
        files: files.map(([rel]) => path.posix.normalize(rel)).sort(),
      };
    }
    if (errors.length) return { ok: false, errors, plan };
    if (dryRun) return { ok: true, plan, source: payload.source || null };

    for (const [name, data] of entries) {
      const s = servers.get(name);
      const usable = Object.fromEntries(Object.entries(data.settings || {}).filter(([k]) => !RESERVED_ENV.has(k)));
      if (Object.keys(usable).length) {
        const errs = store.updateSettings(name, { set: usable }, RESERVED_ENV);
        if (errs.length) return { ok: false, errors: errs.map((x) => `${name}: ${x}`), plan };
      }
      for (const [rel, b64] of Object.entries(data.files || {})) {
        const dest = path.join(s.dataDir, path.posix.normalize(rel));
        mkdirSync(path.dirname(dest), { recursive: true });
        if (existsSync(dest)) renameSync(dest, `${dest}.before-import`);
        writeFileSync(dest, Buffer.from(b64, 'base64'), { mode: 0o600 });
      }
      s.note(`imported ${plan[name].settings.length} setting(s) and ${plan[name].files.length} file(s)${payload.source ? ` from ${payload.source}` : ''}`);
      incident({ server: name, action: `imported settings and data${payload.source ? ` from ${payload.source}` : ''}` });
      plan[name].action = applyLive(s, 'imported settings and data');
    }
    return { ok: true, plan, source: payload.source || null };
  }

  // ---- routing and reporting ---------------------------------------------

  /** Router lookup: which server owns a hostname, and is it running. */
  function resolve(hostname) {
    for (const s of servers.values()) {
      if (!(s.rec.hostnames || []).includes(hostname)) continue;
      if (s.child) return { name: s.name, port: s.rec.port };
      return { name: s.name, unavailable: s.statusDetail() || s.status() };
    }
    return null;
  }

  function hostHealth() {
    const list = [...servers.values()].map((s) => [s.name, { status: s.status(), hostnames: s.rec.hostnames || [] }]);
    const failing = list.filter(([, v]) => !['healthy', 'stopped'].includes(v.status)).map(([n]) => n);
    return {
      heartbeat: { status: 'ok', servers: Object.fromEntries(list) },
      health: { status: failing.length ? 'failing' : 'ok', failing, servers: Object.fromEntries(list) },
    };
  }

  function detail(name) {
    const s = get(name);
    const rec = s.rec;
    const settings = store.settings(name);
    return {
      ...s.snapshot(),
      repo: rec.repo,
      autoUpdate: !!rec.autoUpdate,
      enabled: !!rec.enabled,
      current: rec.current ? { tag: rec.current.tag, version: rec.current.version, installedAt: rec.current.installedAt } : null,
      previous: rec.previous && existsSync(rec.previous.dir) ? { tag: rec.previous.tag, version: rec.previous.version } : null,
      rejected: rec.rejected || null,
      publicUrl: settings.PUBLIC_URL || s.publicUrl(),
      dataDir: s.dataDir,
      healthPaths: s.manifest ? { heartbeat: s.manifest.health.heartbeat, health: s.manifest.health.health } : null,
      mcpPath: s.manifest?.mcp?.path || null,
      fields: s.fields().map((f) => ({ env: f.env, label: f.label, secret: f.secret, required: f.required, note: f.note, default: f.default || null, aliases: f.aliases })),
      // Plain (non-secret) values are shown outright; secret values only on request.
      settings: {
        set: Object.keys(settings).sort(),
        plain: Object.fromEntries(
          s.fields().filter((f) => !f.secret).flatMap((f) => [f.env, ...f.aliases]).filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]),
        ),
        missing: s.missing(),
      },
      logTail: s.tail.slice(),
      incidents: recentIncidents(500).filter((i) => i.server === name).slice(0, 20),
    };
  }

  return {
    servers,
    jobs,
    get,
    boot,
    shutdown,
    tick,
    addServer,
    removeServer,
    startUpdate,
    checkUpdates,
    rollback,
    start,
    stop,
    restart,
    updateSettings,
    setHostnames,
    setAutoUpdate,
    importData,
    resolve,
    hostHealth,
    detail,
    snapshots: () => [...servers.values()].map((s) => s.snapshot()),
    secretValues: (name) => (get(name), store.settings(name)),
  };
}
