# HA Server Host

Home Assistant add-on repository with one add-on, **HA Server Host** (slug `ha_server_host`, amd64).
It runs any number of servers on the HA machine, each from its repo's latest GitHub release,
routes one public port to them by hostname, and keeps each one healthy without touching the others.

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
host's Node) so native modules match, plus `ha-server.json` at its root.

The smallest manifest:

```json
{
  "manifestVersion": 1,
  "name": "hello",
  "start": ["node", "server.mjs"],
  "port": 3000,
  "health": { "heartbeat": "/heartbeat", "health": "/health" }
}
```

A fuller one:

```json
{
  "manifestVersion": 1,
  "name": "my-app",
  "displayName": "My App",
  "description": "Web app with an MCP server at /mcp",
  "version": "1.2.0",
  "node": 22,
  "start": ["node", "web/.output/server/index.mjs"],
  "port": 3000,
  "env": { "RULES_DIR": "{{bundle}}/rules", "CACHE_DIR": "{{data}}/cache" },
  "health": { "heartbeat": "/heartbeat", "health": "/health", "startupSeconds": 90 },
  "mcp": { "path": "/mcp" },
  "hostnames": ["my-app.example.com"],
  "hostSettings": ["turso"],
  "settings": [
    { "env": "AUTH_SECRET", "label": "Session secret", "secret": true, "required": true },
    { "env": "TZ", "label": "Time zone", "default": "America/Los_Angeles" },
    { "env": "TURSO_DATABASE_URL", "label": "Database URL", "required": true, "aliases": ["DATABASE_URL"] }
  ]
}
```

### Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `manifestVersion` | yes | Always `1`. |
| `name` | yes | Server id: lowercase letters, digits and `-`, up to 41 characters. Names its page, data folder and settings. |
| `displayName`, `description`, `version` | no | Shown on the server's page. `displayName` defaults to `name`. |
| `node` | no | Node major version the bundle was built for. If it differs from the host's, the release is refused. |
| `start` | yes | Command run in the bundle folder. An array is run directly (`node` is the host's Node); a string runs through `sh -c`. |
| `port` | yes | Preferred internal port (1024 to 65535). The host passes the port it actually assigns as `PORT`; the server must listen on that. |
| `env` | no | Fixed environment variables. Values may use `{{bundle}}` (the release folder) and `{{data}}` (`DATA_DIR`). |
| `health.heartbeat` | yes | Path that answers 2xx while the process is alive. |
| `health.health` | yes | Path that answers 2xx when the server is usable. |
| `health.startupSeconds` | no | How long a new release has to pass its checks (5 to 600, default 90). |
| `mcp.path` | no | Where the server's MCP endpoint lives, shown on its page. |
| `hostnames` | no | Default public hostnames. They can be changed on the server's page. |
| `hostSettings` | no | Shared values from the Host page to pass in. Today only `turso`, which sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` unless the server's own settings set them. |
| `settings` | no | Fields shown on the server's page, each passed as an environment variable. See below. |

Each entry in `settings`:

| Key | Meaning |
|---|---|
| `env` | Variable name. |
| `label` | Text shown on the page. |
| `secret` | `true` hides the value until Show is chosen. |
| `required` | `true` keeps the server stopped ("needs settings") until a value is set. |
| `default` | Value used when none is set. |
| `note` | Help text under the field. |
| `aliases` | Older variable names the server also reads. A value stored under one of them counts for a required setting. |

The host always sets `PORT`, `HOST`, `DATA_DIR`, `NODE_ENV`, `PATH` and `HOME`, so `env` and
`settings` may not use those names. Unknown keys are rejected, so a typo shows up as an error on
the Add page instead of being ignored.

### Adding and removing a server

1. Publish a tagged release with the bundle as above.
2. For a private repo, set a GitHub token on the Host page (fine-grained, Contents read-only).
3. Choose Add server in the panel and enter the repo as `owner/repo` or its GitHub URL. The host
   downloads the latest release, checks the manifest and creates the server's page.
4. Fill in any required settings. The server starts once nothing required is missing.
5. Point a hostname at port 8110 (for example a Cloudflare Tunnel public hostname) and set it on
   the server's page if it differs from the manifest default.

To remove one, choose Remove on its page. The server is stopped and its releases are deleted. You
choose whether to keep its settings and its `DATA_DIR` folder, so adding it again later can pick
up where it left off.

## Importing settings and data

The Host page can import an export file (JSON) holding settings and data files for one or more
servers, for example from an add-on the servers used to run in. The host lists every setting and
data file it will write before anything changes; Import applies it and restarts only the affected
servers. Existing data files are kept as `*.before-import`.

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

## License

MIT. See [LICENSE](LICENSE).
