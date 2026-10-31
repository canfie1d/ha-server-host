import { log } from './util.mjs';

const CORE = 'http://supervisor/core/api/services';

async function call(token, service, body) {
  const res = await fetch(`${CORE}/${service}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${service} -> HTTP ${res.status}`);
}

const notificationId = (key) => `ha_server_host_${String(key).replace(/[^a-z0-9_]/gi, '_')}`;

/**
 * Alerts through Home Assistant (homeassistant_api). Always a persistent notification, one per
 * server so a newer alert replaces an older one, plus a push through the notify service set on
 * the Host page when there is one.
 */
export function createNotifier({ supervisorToken, hostSettings }) {
  async function notify(key, title, message) {
    log('notify', `${title}: ${message.replace(/\n/g, ' ')}`);
    if (!supervisorToken) return;
    const service = (hostSettings().notify_service || '').replace(/^notify\./, '');
    const sends = [call(supervisorToken, 'persistent_notification/create', { notification_id: notificationId(key), title, message })];
    if (service) sends.push(call(supervisorToken, `notify/${service}`, { title, message }));
    for (const r of await Promise.allSettled(sends)) {
      if (r.status === 'rejected') log('notify', `delivery failed: ${r.reason?.message || r.reason}`);
    }
  }

  /** Clear a server's notification once the problem it reported is gone. */
  function dismiss(key) {
    if (!supervisorToken) return;
    call(supervisorToken, 'persistent_notification/dismiss', { notification_id: notificationId(key) }).catch(() => {});
  }

  return { notify, dismiss };
}
