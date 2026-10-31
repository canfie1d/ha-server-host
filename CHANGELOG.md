# Changelog

## 2.0.2

- Show each server page's sections as tabs
- Document the manifest fields and adding and removing a server
- Add MIT license and use generic examples

## 2.0.1

- Run tests by file glob so Node 22 finds them

## 2.0.0

- HA Server Host replaces MCP Host. It installs each server from its repo's latest GitHub release (a prebuilt bundle with an `ha-server.json` manifest) instead of cloning and building on the HA machine.
- Add a server by giving its GitHub repo; remove it with the choice to keep its settings and data.
- One page per server: status, Start, Stop, Restart, Update, Roll back, public hostnames, settings, logs and incidents.
- One public port (8110) for every server, routed by hostname. Point Cloudflare Tunnel at it.
- Restarts a server after repeated failed heartbeats; alerts without restarting when only its health check fails. Alerts are Home Assistant notifications.
- An update that fails its health check is reverted to the previous release automatically, with an alert.
- One-time import of settings and data exported by the MCP Host and Financial Advisor add-ons.
- Claude auto-patching, git clones and on-device builds are gone, and the image no longer carries git, pnpm or compilers.
