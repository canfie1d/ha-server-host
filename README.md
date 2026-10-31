# HA Server Host

Home Assistant add-on repository with one add-on, **HA Server Host** (slug `ha_server_host`, amd64).
It runs any number of servers on the HA machine, each from its repo's latest GitHub release,
routes one public port to them by hostname, and keeps each one healthy without touching the others.
It replaces MCP Host (`mcp_host`).

Install: HA > Settings > Add-ons > Add-on Store > ⋮ > Repositories > add
`https://github.com/canfie1d/ha-server-host`.

## What it does

- **Add a server** by giving its GitHub repo. The host downloads the latest release's
  `bundle-linux-x64.tar.gz`, checks it against `bundle-linux-x64.tar.gz.sha256` when the release
  has one, reads the `ha-server.json` manifest inside it and creates the server's page. Fill in the
  settings it asks for and it starts. Nothing is cloned or built on the HA machine.
- **Remove a server** from its page. It is stopped and its releases are deleted; you choose whether
  to keep its settings and its data folder.
- **One page per server** in the Server Host sidebar panel: status, Start, Stop, Restart, Update,
  Roll back, public hostnames, settings, live logs and incidents.
- **Routing.** Port 8110 is the only published port. Cloudflare Tunnel sends every hostname there
  and the host passes each request to the server that owns the hostname (`X-Forwarded-Host`, then
  `Host`). WebSocket upgrades and streaming responses pass through.
- **Isolation.** Each server is its own process group with its own environment, port, data folder
  and log. A crash, restart, update or settings change on one server never restarts another.
  Updating the add-on itself restarts all of them.
- **Updates.** With automatic updates on (the default, per server) the host checks every 10
  minutes for a new release. Update on the page installs the latest release now.

## Health and failure handling

Every server answers two paths, named in its manifest:

| Path | Meaning | When it fails |
|---|---|---|
| `/heartbeat` | the process is alive | after 3 failures in a row (30 s apart) the host restarts the server and sends an alert |
| `/health` | the server is usable (auth, upstream, data) | the server shows "needs attention" and an alert goes out (again every 12 h); it is never restarted, since a restart cannot fix an expired credential |

- A process that exits unexpectedly is restarted with backoff (1 s up to 30 s). After 5 exits in 10
  minutes the host stops trying for 30 minutes and sends a "down" alert.
- **Updates are checked.** A new release must pass `/health` within its startup time (or at least
  `/heartbeat`, when health was already failing before the update). If it does not, the host puts
  the previous release back, sends an alert and does not install that release again on its own.
- The previous release stays on disk, so Roll back is instant.
- Alerts are Home Assistant persistent notifications, one per server (a newer alert replaces the
  older one; it is cleared when health recovers). With a notify service set on the Host page they
  are also pushed to a phone.

The host's own `/heartbeat` and `/health` answer on any hostname no server owns. The add-on
watchdog uses `/heartbeat`, which only reports on the host process, so one server being down
never restarts the add-on.

## Settings

- **Server settings** are environment variables, set on each server's page and stored in the
  host's private `/data/settings.json` (0600). The manifest names them, marks which are secret and
  which are required. Secret values stay hidden until you choose Show and are only served through
  HA ingress. Saving restarts that server only.
- **Host settings** (Host page): a GitHub token for private repos (fine-grained, Contents read-only
  on the server repos), an optional notify service, and an optional shared Turso URL and token for
  servers whose manifest asks for them.
- The host always sets `PORT`, `HOST=127.0.0.1`, `DATA_DIR` (a persistent folder per server under
  `/data/server-data/<name>`) and `NODE_ENV=production`, and sets `PUBLIC_URL` to
  `https://<first hostname>` unless a setting overrides it.

## Making a server hostable

A server repo needs a release workflow that, on a version tag, builds the server and attaches
`bundle-linux-x64.tar.gz` (and optionally its `.sha256`) to a GitHub Release. The archive holds
everything needed to run with no install or build step, built on linux-x64 with Node 22 (the
host's Node) so native modules match, plus `ha-server.json` at its root:

```json
{
  "manifestVersion": 1,
  "name": "personal-chef",
  "displayName": "Personal Chef",
  "description": "Meal planning web app with an MCP server at /mcp",
  "version": "1.0.25",
  "node": 22,
  "start": ["node", "web/.output/server/index.mjs"],
  "port": 3000,
  "env": { "MCP_IN_PROCESS": "1", "CHEF_RULES_DIR": "{{bundle}}/rules" },
  "health": { "heartbeat": "/heartbeat", "health": "/health", "startupSeconds": 90 },
  "mcp": { "path": "/mcp" },
  "hostnames": ["personal-chef.ryanandkaitlin.com"],
  "hostSettings": [],
  "settings": [
    { "env": "AUTH_SECRET", "label": "Session secret", "secret": true, "required": true },
    { "env": "TZ", "label": "Time zone", "default": "America/Los_Angeles" }
  ]
}
```

- `start` runs in the bundle folder. An array is run directly (`node` is the host's Node); a string
  runs through `sh -c`.
- `port` is the preferred internal port. The host passes the port it assigns as `PORT`; the server
  must listen on it.
- `env` values may use `{{bundle}}` (the release folder) and `{{data}}` (`DATA_DIR`).
- `hostnames` are defaults; they can be changed on the server's page.
- `hostSettings: ["turso"]` passes the Host page's shared Turso values as `TURSO_DATABASE_URL` and
  `TURSO_AUTH_TOKEN` (the server's own settings win).
- `node`, when set, must match the host's Node major version or the release is refused.

## Moving from the old add-ons

Another add-on cannot read the old add-ons' `/data`, so their final releases export it:

1. Update MCP Host and Financial Advisor to their export releases and download the export file from
   each one's panel.
2. Install HA Server Host, set the GitHub token on the Host page, and add each server.
3. On the Host page, choose an export file under Import. The host lists every setting and data
   file it will write; Import applies it and restarts the affected servers. Existing data files are
   kept as `*.before-import`.

## Development

```sh
node --test test/*.test.mjs # end to end: fake GitHub API, real bundles, the host as a subprocess
DATA_DIR=./local/data HOST_TRUST_ALL=1 GITHUB_TOKEN=... node src/index.mjs
```

`HOST_TRUST_ALL=1` opens the panel to any client (it normally answers only HA's ingress proxy);
use it locally only. The panel is on port 8100 and the router on 8110 (`HOST_PANEL_PORT`,
`HOST_ROUTER_PORT`).

## Releases

Push a version tag (`git tag v2.0.1 && git push origin v2.0.1`). The Release workflow tests,
publishes `ghcr.io/canfie1d/amd64-addon-ha-server-host:<version>` and records the version in
`config.yaml` and `CHANGELOG.md` on `main`. Pushes to `main` only run CI.
