// The one public entry point: Cloudflare Tunnel sends every hostname to this port and the router
// passes each request to the server that owns the hostname. Requests for any other host (the HA
// watchdog, direct IP access) get only the host's own /heartbeat and /health.
import http from 'node:http';
import net from 'node:net';

/** The public hostname a request was made for (the tunnel may put it in X-Forwarded-Host). */
export function requestHost(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return raw.split(',')[0].trim().replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
}

// The server sees the public hostname that routing matched (it may have come from
// X-Forwarded-Host), so its own origin and allowed-hosts checks pass.
function forwardHeaders(req, hostname) {
  const headers = { ...req.headers, host: hostname };
  // Left exactly as the tunnel sent it, so a server's rate limiter sees the real client.
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'https';
  if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = hostname;
  return headers;
}

const sendJson = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
};

/**
 * resolve(hostname) returns null for an unknown host, { name, unavailable } for a server that
 * is not running, or { name, port }. hostHealth() returns { heartbeat, health } bodies for the
 * host's own endpoints.
 */
export function createRouter({ resolve, hostHealth, onError = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const hostname = requestHost(req);
    const target = resolve(hostname);
    if (target?.port) return proxy(req, res, target, hostname);
    if (target) return sendJson(res, 503, { error: `${target.name} is not running`, reason: target.unavailable }, { 'retry-after': '30' });

    const pathOnly = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && pathOnly === '/heartbeat') {
      // The host itself is alive. Server problems never fail this, so the HA watchdog never
      // restarts the add-on (and with it every server) because one server is down.
      return sendJson(res, 200, (await hostHealth()).heartbeat);
    }
    if (req.method === 'GET' && pathOnly === '/health') {
      const body = (await hostHealth()).health;
      return sendJson(res, body.status === 'ok' ? 200 : 503, body);
    }
    sendJson(res, 404, { error: 'Unknown host' });
  });

  function proxy(req, res, target, hostname) {
    const upstream = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req, hostname) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      onError(target.name, err);
      if (!res.headersSent) sendJson(res, 502, { error: `${target.name} is not answering` });
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  // WebSocket and other upgrades: hand the raw socket to the server once it accepts.
  server.on('upgrade', (req, socket, head) => {
    const hostname = requestHost(req);
    const target = resolve(hostname);
    if (!target?.port) return socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
    const up = net.connect(target.port, '127.0.0.1', () => {
      const headers = forwardHeaders(req, hostname);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Long-lived MCP streams and server-sent events must not be cut off.
  server.requestTimeout = 0;
  return server;
}
