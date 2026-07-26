# Unseen Servant — Complete Setup Guide

This guide walks you from an empty server to playing D&D on your phone,
step by step. No prior Docker knowledge needed — if you can paste commands
into a terminal, you can run this.

**What you're setting up:** one `docker compose` stack containing
[Foundry VTT](https://foundryvtt.com) (your virtual tabletop), the companion
web app your players open on their phones, and the relay plumbing that
connects the two. The GM runs the table in Foundry as usual; players manage
their characters — rolls, spells, inventory, combat — from their phones.

---

## 1. What you need

| Requirement | Notes |
|---|---|
| A Linux server, VPS, or home machine | 2 GB RAM is plenty. Windows/macOS with Docker Desktop also work for trying it out. |
| Docker with Compose v2 | `docker compose version` should print a version. Rootless Podman works too. |
| Node.js 22+ | Only used by the setup wizard and updater: `node --version`. |
| A Foundry VTT license | Your foundryvtt.com account. You do NOT need to download Foundry — the stack fetches it with your credentials. |

> **One license, one server:** a Foundry license allows one active server at a
> time. If you already run Foundry elsewhere, stop it before starting this
> stack (or see the issue tracker — connecting to an existing instance is a
> planned feature).

## 2. Install

```bash
git clone https://github.com/Tenezill/unseen-servant.git
cd unseen-servant
make setup
```

`make setup` starts an interactive wizard. It prints a link like
`http://<your-ip>:8322/s/<token>/` — open that in a browser (nicer), or just
press Enter in the terminal to answer there instead.

The wizard asks for:

1. **Your foundryvtt.com username/email and password.** Used once by the
   Foundry container to download its release and fetch your license. Stored
   only in `./secrets/` on your machine (file mode 0600), never sent anywhere
   else.
2. **License key** — leave blank; it's fetched from your account
   automatically.
3. **Where will you (the GM) reach this server?** — pre-filled with your
   machine's LAN IP. Press Enter to accept, or type a domain if you have one.
   Pairing links and the module URL are built from this answer.
4. **HTTPS on your own domain?** — optional, skip for a first run (see
   section 8).

### ⚠️ The generated-secrets page — write these down

The wizard generates four secrets and shows them **exactly once**:

| Secret | You'll need it when |
|---|---|
| Foundry admin key | Unlocking Foundry's setup screen (step 3) |
| Companion user password | Creating the app's GM user in your world (step 4) |
| Relay account password | Approving the pairing (step 5) |
| App admin password | Opening the app's `/admin` console (step 6) |

Save them, then confirm — the stack starts. First boot downloads Foundry
(a few minutes). Watch progress at `http://<your-ip>:8321`.

## 3. First-time Foundry setup

Open `http://<your-ip>:30000`.

1. Accept the license/EULA (your key was fetched automatically).
2. If prompted for the admin password, use the **Foundry admin key** from
   the secrets page.
3. Install the game system you play (e.g. "D&D Fifth Edition") under
   **Game Systems → Install System**.
4. Create your world and launch it.

## 4. Create the Companion user

The app logs into your world through a dedicated GM user, so YOUR
Gamemaster seat stays free (Foundry allows one session per user).

In your world: **Settings → User Management**, create a user named exactly
`Companion` with role **Gamemaster**, and set its password to the
**Companion user password** from the secrets page.

## 5. Connect the module (order matters!)

The stack already installed the "Foundry REST API" module into your Foundry —
you just have to enable and point it:

1. In your world: **Settings → Manage Modules** → enable **Foundry REST API**.
2. **Before clicking anything else**, open the module's settings and set
   **WebSocket Relay URL** to `ws://<your-answer-from-the-wizard>:3010` —
   the exact value is displayed in the app's admin console under
   **Relay & pairing** (step 6). Save; the world reloads.

   > If you click **Pair** while the URL still has its default value, you'll
   > be sent to the public `foundryrestapi.com` site, where your account does
   > not exist. Fix the URL first, then pair.
3. Click the module's **Pair** button. A page on YOUR relay opens
   (`http://<host>:3010/pair/…`). Log in with email
   `bootstrap@companion.local` and the **relay account password** from the
   secrets page, and approve.
4. Reload the world so the module reconnects.

## 6. Invite your players

1. Open the app: `http://<your-ip>:8080` → **/admin** → log in with the
   **app admin password**.
2. The **Relay & pairing** panel shows the relay account and the module URL
   from step 5 — plus, for each player you add: create a player entry, link
   it to their character in your world, and generate an **invite link**.
3. Send each player their link. On their phone it opens the app already
   logged in — they can add it to their home screen like a native app
   (browser menu → "Add to Home Screen").

That's it — you're playing.

## 7. Updating

```bash
cd unseen-servant
make update
```

Data-safe by design: it pulls the new pinned image versions and recreates
only changed containers. Your world, players, secrets, and relay pairings
are never touched.

## 8. Remote access & HTTPS (optional)

For play over the internet on your own domain:

1. Point two DNS records at your server (e.g. `app.example.com` and
   `vtt.example.com`).
2. Re-run setup with the TLS questions: `make setup-reset && make setup`
   (world data is untouched — only config/secrets regenerate) and answer
   the HTTPS prompts.
3. Ports 80/443 must be reachable; certificates come from Let's Encrypt
   automatically.

Without a domain, players on your LAN just use `http://<your-ip>:8080`; for
remote players a VPN like Tailscale pointed at the same ports works well.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Foundry container logs "insufficient permissions on /data" | Setup was run as a non-root user that can't align file ownership. Run `sudo chown -R 1000:1000 foundry_data secrets/foundry-config.json` and restart. (Running `make setup` as root handles this automatically.) |
| Pair button opens foundryrestapi.com | The module's WebSocket Relay URL is still the default. See step 5.2. |
| "Copy" buttons in the app do nothing | Browsers only allow clipboard access on HTTPS or localhost. Select and copy the text manually, or set up TLS (section 8). |
| Port already in use on startup | Something else uses 8080/30000/3010/8321. Change `HOST_PORT_*` in `.env` and `docker compose up -d`. |
| Foundry asks for credentials again after a reboot and no world loads | Set `FOUNDRY_WORLD=<your-world-id>` in `.env` so the world auto-launches, then `docker compose up -d`. |
| "This license key is already in use" | Your license is active on another server. Stop the other Foundry first. |
| Wizard link unreachable on a remote server | Tunnel it: `ssh -L 8322:localhost:8322 <host>`, then open `http://localhost:8322/s/<token>/`. |

Logs are your friend: `docker compose logs -f foundry` (or `gateway`,
`relay`, `bootstrap`, `web`).

## 10. Getting help

Open an issue: https://github.com/Tenezill/unseen-servant/issues — include
your OS, how you installed Docker, and the relevant `docker compose logs`
output (never paste your `secrets/` files).
