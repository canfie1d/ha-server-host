// The manifest every server bundle carries at its root as ha-server.json. It tells the host how to
// run the server and what to show on its page. Example:
//
// {
//   "manifestVersion": 1,
//   "name": "personal-chef",
//   "displayName": "Personal Chef",
//   "description": "Meal planning web app with an MCP server at /mcp",
//   "version": "1.0.25",
//   "node": 22,
//   "start": ["node", "web/.output/server/index.mjs"],
//   "port": 3000,
//   "env": { "MCP_IN_PROCESS": "1", "CHEF_RULES_DIR": "{{bundle}}/rules" },
//   "health": { "heartbeat": "/heartbeat", "health": "/health", "startupSeconds": 90 },
//   "mcp": { "path": "/mcp" },
//   "hostnames": ["personal-chef.ryanandkaitlin.com"],
//   "hostSettings": ["turso"],
//   "settings": [
//     { "env": "AUTH_SECRET", "label": "Session secret", "secret": true, "required": true },
//     { "env": "TZ", "label": "Time zone", "default": "America/Los_Angeles" },
//     { "env": "TURSO_DATABASE_URL", "label": "Database URL", "required": true, "aliases": ["DATABASE_URL"] }
//   ]
// }
//
// The host always sets PORT (the server must listen on it), HOST=127.0.0.1, DATA_DIR (a persistent
// directory for this server) and NODE_ENV=production, and PUBLIC_URL from the first hostname
// unless a setting overrides it. "{{bundle}}" and "{{data}}" in env values expand to the bundle
// directory and DATA_DIR. A setting's "aliases" are older names the server also reads; a value
// stored under one of them satisfies a required setting.

export const MANIFEST_FILE = 'ha-server.json';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Set by the host for every server; a manifest or a setting may not override them.
export const RESERVED_ENV = new Set(['PORT', 'HOST', 'DATA_DIR', 'NODE_ENV', 'PATH', 'HOME']);
export const HOST_SETTING_GROUPS = {
  turso: { TURSO_DATABASE_URL: 'turso_database_url', TURSO_AUTH_TOKEN: 'turso_auth_token' },
};

const TOP_KEYS = new Set([
  'manifestVersion', 'name', 'displayName', 'description', 'version', 'node', 'start', 'port', 'env',
  'health', 'mcp', 'hostnames', 'hostSettings', 'settings',
]);
const FIELD_KEYS = new Set(['env', 'label', 'secret', 'required', 'note', 'default', 'aliases']);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isPath = (v) => isStr(v) && v.startsWith('/') && !/\s/.test(v);

/** Returns a list of problems; empty means valid. */
export function validateManifest(m) {
  if (!isObj(m)) return ['manifest must be a JSON object'];
  const errors = [];
  for (const k of Object.keys(m)) if (!TOP_KEYS.has(k)) errors.push(`unknown key "${k}"`);
  if (m.manifestVersion !== 1) errors.push('"manifestVersion" must be 1');
  if (!isStr(m.name) || !NAME_RE.test(m.name)) errors.push('"name" must be lowercase letters, digits and "-" (max 41 chars)');
  for (const k of ['displayName', 'description', 'version']) {
    if (m[k] !== undefined && typeof m[k] !== 'string') errors.push(`"${k}" must be a string`);
  }
  if (m.node !== undefined && !(Number.isInteger(m.node) && m.node > 0)) errors.push('"node" must be a Node major version number');

  const startOk = isStr(m.start) || (Array.isArray(m.start) && m.start.length > 0 && m.start.every(isStr));
  if (!startOk) errors.push('"start" must be a command string or a non-empty array of strings');
  if (!Number.isInteger(m.port) || m.port < 1024 || m.port > 65535) errors.push('"port" must be an integer between 1024 and 65535');

  if (m.env !== undefined) {
    if (!isObj(m.env)) errors.push('"env" must be an object');
    else
      for (const [k, v] of Object.entries(m.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`env name "${k}" is invalid`);
        else if (RESERVED_ENV.has(k)) errors.push(`env ${k} is set by the host`);
        if (typeof v !== 'string') errors.push(`env ${k} must be a string`);
      }
  }

  if (!isObj(m.health)) errors.push('"health" is required');
  else {
    if (!isPath(m.health.heartbeat)) errors.push('health.heartbeat must be a path starting with "/"');
    if (!isPath(m.health.health)) errors.push('health.health must be a path starting with "/"');
    const s = m.health.startupSeconds;
    if (s !== undefined && !(Number.isInteger(s) && s >= 5 && s <= 600)) errors.push('health.startupSeconds must be 5 to 600');
  }
  if (m.mcp !== undefined && !(isObj(m.mcp) && isPath(m.mcp.path))) errors.push('mcp.path must be a path starting with "/"');

  if (m.hostnames !== undefined) {
    if (!Array.isArray(m.hostnames) || m.hostnames.some((h) => !isStr(h) || !HOSTNAME_RE.test(h.toLowerCase()))) {
      errors.push('"hostnames" must be an array of hostnames like app.example.com');
    }
  }
  if (m.hostSettings !== undefined) {
    if (!Array.isArray(m.hostSettings) || m.hostSettings.some((g) => !HOST_SETTING_GROUPS[g])) {
      errors.push(`"hostSettings" may only list: ${Object.keys(HOST_SETTING_GROUPS).join(', ')}`);
    }
  }

  if (m.settings !== undefined) {
    if (!Array.isArray(m.settings)) errors.push('"settings" must be an array');
    else {
      const seen = new Set();
      m.settings.forEach((f, i) => {
        const where = isObj(f) && isStr(f.env) ? `setting ${f.env}` : `settings[${i}]`;
        if (!isObj(f)) return errors.push(`${where}: must be an object`);
        for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) errors.push(`${where}: unknown key "${k}"`);
        if (!isStr(f.env) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.env)) errors.push(`${where}: "env" must be a variable name`);
        else if (RESERVED_ENV.has(f.env)) errors.push(`${where}: ${f.env} is set by the host`);
        else if (seen.has(f.env)) errors.push(`${where}: listed twice`);
        else seen.add(f.env);
        if (!isStr(f.label)) errors.push(`${where}: "label" is required`);
        for (const k of ['secret', 'required']) if (f[k] !== undefined && typeof f[k] !== 'boolean') errors.push(`${where}: "${k}" must be true or false`);
        for (const k of ['note', 'default']) if (f[k] !== undefined && typeof f[k] !== 'string') errors.push(`${where}: "${k}" must be a string`);
        if (f.aliases !== undefined && (!Array.isArray(f.aliases) || f.aliases.some((a) => !isStr(a) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a) || RESERVED_ENV.has(a)))) {
          errors.push(`${where}: "aliases" must be an array of variable names`);
        }
      });
    }
  }
  return errors;
}

/** Fill in the optional parts so the rest of the host can read a manifest without checks. */
export function normalizeManifest(m) {
  return {
    ...m,
    displayName: m.displayName || m.name,
    description: m.description || '',
    env: m.env || {},
    health: { startupSeconds: 90, ...m.health },
    mcp: m.mcp || null,
    hostnames: (m.hostnames || []).map((h) => h.toLowerCase()),
    hostSettings: m.hostSettings || [],
    settings: (m.settings || []).map((f) => ({ secret: false, required: false, note: '', aliases: [], ...f })),
  };
}
