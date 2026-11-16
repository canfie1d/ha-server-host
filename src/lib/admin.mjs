// Token-authenticated access to the panel's JSON API from outside Home Assistant.
//
// The panel API only answers HA's ingress proxy. This lets a trusted automation (a script, a CI
// job, Claude) add servers and set their settings, including secrets, through the router port on
// one hostname that the owner chooses. It is off until both host settings are set:
//   admin_hostname  the hostname that serves it, e.g. ha-server-host.example.com
//   admin_token     a long random bearer token (32+ characters)
// It serves /api/* and /status.json only, never the HTML pages. Secrets can be written but are
// never read back: settings reads return names only.
import { createHash, timingSafeEqual } from 'node:crypto';

const WINDOW_MS = 5 * 60_000;
const MAX_FAILS_PER_CLIENT = 10;
const MAX_FAILS_TOTAL = 60;

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function createAdminAuth({ hostSettings, now = Date.now }) {
  const fails = new Map(); // client -> [timestamps]

  function config() {
    const h = hostSettings();
    return { token: h.admin_token || '', hostname: String(h.admin_hostname || '').toLowerCase() };
  }

  function recent(client) {
    const cutoff = now() - WINDOW_MS;
    const list = (fails.get(client) || []).filter((t) => t > cutoff);
    if (list.length) fails.set(client, list);
    else fails.delete(client);
    return list;
  }

  const clientOf = (req) =>
    String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();

  return {
    /** Is this request for the admin API? Only when it is configured and the hostname matches. */
    handles(hostname, pathOnly) {
      const { token, hostname: admin } = config();
      return !!token && !!admin && hostname === admin && (pathOnly === '/status.json' || pathOnly.startsWith('/api/'));
    },

    /** { ok: true } or { ok: false, status, error }. Repeated failures are throttled. */
    check(req) {
      const client = clientOf(req);
      const total = [...fails.keys()].reduce((n, c) => n + recent(c).length, 0);
      if (recent(client).length >= MAX_FAILS_PER_CLIENT || total >= MAX_FAILS_TOTAL) {
        return { ok: false, status: 429, error: 'too many failed attempts; try again in a few minutes' };
      }
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      const { token } = config();
      if (m && token && timingSafeEqual(digest(m[1]), digest(token))) return { ok: true };
      fails.set(client, [...recent(client), now()]);
      return { ok: false, status: 401, error: 'missing or wrong bearer token' };
    },
  };
}
