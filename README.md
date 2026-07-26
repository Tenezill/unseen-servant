# Unseen Servant

A mobile-first companion app for [Foundry VTT](https://foundryvtt.com):
players manage their characters — rolls, spells, inventory, combat — from
their phone while the GM runs the table in Foundry. Currently supports
D&D 5e (best supported), I'm working on getting more systems in. 

Free to use. The app itself is closed-source; this repo contains the
installer and deployment files.

## What you get

One `docker compose` stack: Foundry VTT (bring your own license), the
[foundryvtt-rest-api relay](https://github.com/ThreeHats/foundryvtt-rest-api-relay),
the companion gateway + web app, and a bootstrap sidecar that wires
everything together automatically (module install, relay pairing key).

## Requirements

- Docker with Compose v2, or rootless Podman with podman-compose
- Node.js 22+ (runs the setup wizard and updates)
- A Foundry VTT license (foundryvtt.com account)

**New here? The [step-by-step setup guide](GUIDE.md) covers everything from
empty server to playing on your phone — including the pairing flow and
troubleshooting.**

## Install

```bash
git clone https://github.com/Tenezill/unseen-servant.git
cd unseen-servant
make setup
```

The wizard asks for your foundryvtt.com credentials (used once by the
Foundry container to fetch its release), generates all other secrets, writes
them to `./secrets/` (mode 0600), and starts the stack.

Afterwards:

- Web app: http://localhost:8080
- Foundry: http://localhost:30000
- Relay: http://localhost:3010

Ports are configurable in the generated `.env`.

## Update

```bash
make update
```

Data-safe by construction: pulls new pinned image versions and recreates only
changed containers. Never touches your world data, players, secrets, or
relay DB (all live in bind-mount folders next to this file).

## TLS / remote access

Re-run `make setup` and answer the TLS prompts, or see the comments in
`Caddyfile.tls.example`. Rootless Podman note: binding ports 80/443 needs
`sysctl net.ipv4.ip_unprivileged_port_start=80`.

## License

Everything here is free to use, including commercially (e.g. paid game
sessions) — but nothing may be resold. The deployment files in this repo are
covered by the [Deployment Files License](LICENSE); the app's container
images (`ghcr.io/tenezill/unseen-servant-*`) by their EULA (no
redistribution/resale; see `/licence/EULA.md` inside each image, along with
third-party attributions). Foundry VTT and the relay are separate projects
under their own terms.

## Issues

Bug reports and feature requests welcome — open an issue here.
