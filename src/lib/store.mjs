// Everything the host keeps under /data:
//   servers.json   the server registry: repo, installed and previous release, port, hostnames
//   settings.json  each server's settings (environment variables), keyed by server name
//   host.json      the host's own settings (GitHub token, notify service, shared Turso)
// settings.json and host.json hold secrets and are written 0600.
import path from 'node:path';
import { DATA, readJson, validateEnvEdit, writeJson } from './util.mjs';

const SERVERS_FILE = path.join(DATA, 'servers.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const HOST_FILE = path.join(DATA, 'host.json');
const PRIVATE = 0o600;

export const HOST_FIELDS = [
  { key: 'github_token', label: 'GitHub token', secret: true, note: 'Read access to the releases of private server repos (a fine-grained token with Contents: read-only).' },
  { key: 'notify_service', label: 'Notify service', note: 'Optional, e.g. notify.mobile_app_ryans_iphone. Alerts always appear as Home Assistant notifications; this also pushes them to a phone.' },
  { key: 'turso_database_url', label: 'Shared Turso URL', note: 'Optional. Passed as TURSO_DATABASE_URL to servers whose manifest asks for host Turso settings.' },
  { key: 'turso_auth_token', label: 'Shared Turso token', secret: true, note: 'Optional. Passed as TURSO_AUTH_TOKEN alongside the URL.' },
];
const HOST_KEYS = new Set(HOST_FIELDS.map((f) => f.key));

export function createStore() {
  const registry = readJson(SERVERS_FILE, { servers: {} });
  let settings = readJson(SETTINGS_FILE, {});
  let host = readJson(HOST_FILE, {});
  const saveRegistry = () => writeJson(SERVERS_FILE, registry);

  return {
    records: () => Object.values(registry.servers),
    record: (name) => registry.servers[name],
    putRecord(rec) {
      registry.servers[rec.name] = rec;
      saveRegistry();
    },
    deleteRecord(name) {
      delete registry.servers[name];
      saveRegistry();
    },
    saveRegistry,

    settings: (name) => ({ ...(settings[name] || {}) }),
    hasSettings: (name) => !!settings[name],
    /** Apply a { set, remove } edit. Returns a list of problems (empty on success). */
    updateSettings(name, body, reserved) {
      const errors = validateEnvEdit(body, reserved);
      if (errors.length) return errors;
      const next = { ...(settings[name] || {}), ...(body.set || {}) };
      for (const k of body.remove || []) delete next[k];
      settings = { ...settings, [name]: next };
      writeJson(SETTINGS_FILE, settings, { mode: PRIVATE });
      return [];
    },
    deleteSettings(name) {
      const { [name]: _gone, ...rest } = settings;
      settings = rest;
      writeJson(SETTINGS_FILE, settings, { mode: PRIVATE });
    },

    host: () => ({ ...host }),
    updateHost(body) {
      const set = body?.set ?? {};
      const remove = body?.remove ?? [];
      const errors = [];
      if (typeof set !== 'object' || set === null || Array.isArray(set)) errors.push('"set" must be an object');
      else
        for (const [k, v] of Object.entries(set)) {
          if (!HOST_KEYS.has(k)) errors.push(`unknown host setting "${k}"`);
          else if (typeof v !== 'string' || !v.trim()) errors.push(`${k} needs a non-empty value`);
          else if (k === 'notify_service' && !/^(notify\.)?[a-z0-9_]+$/.test(v.trim())) errors.push('notify service must look like notify.mobile_app_phone');
        }
      if (!Array.isArray(remove) || remove.some((k) => !HOST_KEYS.has(k))) errors.push('"remove" must list host setting names');
      if (errors.length) return errors;
      const next = { ...host };
      for (const [k, v] of Object.entries(set)) next[k] = v.trim();
      for (const k of remove) delete next[k];
      host = next;
      writeJson(HOST_FILE, host, { mode: PRIVATE });
      return [];
    },
  };
}
