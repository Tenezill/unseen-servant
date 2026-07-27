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
| Docker with Compose v2 | `docker compose version` should print a version. Rootless Podman works too (podman-compose new enough to support COMPOSE_PROFILES). |
| Node.js 22+ | Only used by the setup wizard and updater: `node --version`. |
| A Foundry VTT license | Your foundryvtt.com account. You do NOT need to download Foundry — the stack fetches it with your credentials. |

> **One license, one server:** a Foundry license allows one active server at a
> time. If you already run Foundry elsewhere, either stop it before starting
> this stack, or connect to it instead — see section 2b.

## 2. Install

```bash
git clone https://github.com/Tenezill/unseen-servant.git
cd unseen-servant
make setup
```

`make setup` starts an interactive wizard. It prints a link like
`http://<your-ip>:8322/s/<token>/` — open that in a browser (nicer), or just
press Enter in the terminal to answer there instead.

The wizard's first question asks whether to run Foundry here or connect to an
existing one. To connect an existing instance, go to section 2b instead. For
the standard bundled setup, the wizard continues with:

1. **Your foundryvtt.com username/email and password.** Used once by the
   Foundry container to download its release and fetch your license. Stored
   only in `./secrets/` on your machine (file mode 0600), never sent anywhere
   else.
2. **License key** — leave blank; it's fetched from your account
   automatically.
3. **Where will you (the GM) reach THIS machine?** — pre-filled with your
   machine's LAN IP. Press Enter to accept, or type a domain if you have one.
   This is an IP/domain, not a URL — and it's the machine running Companion,
   not your Foundry server (that distinction matters in BYO mode, see 2b).
   Pairing links and the module URL are built from this answer.
4. **HTTPS on your own domain?** — optional, skip for a first run (see
   section 8).

## 2b. Connect an existing Foundry (bring your own)

Already running Foundry — native, Docker, or on a VPS? The wizard's first
question lets you connect to it instead of running a bundled one. What
changes versus the standard flow:

- **Before running `make setup`:** in your world, create a Gamemaster-role
  user for the app (suggested name `Companion`) and give it a password —
  the wizard asks for these credentials instead of your foundryvtt.com
  login. Foundry allows one session per user, so this keeps your own GM
  seat free.
- **Foundry URL:** enter it as reachable FROM the machine running the
  companion stack (e.g. `http://192.168.1.9:30000`), not necessarily the
  URL you use in your browser.
- **Module install is manual:** in Foundry, Add-on Modules → Install
  Module, search for "Foundry REST API" (or use the manifest URL from
  https://github.com/ThreeHats/foundryvtt-rest-api/releases — the stack is
  tested against 3.4.1). Then continue with section 5 exactly as written:
  set the WebSocket Relay URL BEFORE clicking Pair.
- **Reboots:** the stack cannot relaunch your world after your Foundry
  restarts — launch it yourself (or use your own auto-launch mechanism,
  e.g. felddy's `FOUNDRY_WORLD` if your Foundry runs in Docker). While a
  world is running, the Companion login keeps it alive for your players.
- **https Foundry (important):** if your Foundry is served over https,
  browsers block the module's insecure `ws://` connection to the relay
  (mixed content). You'll need the relay reachable via `wss://` behind
  your own TLS proxy — supporting this out of the box is planned.
- Hosted providers (Forge, Molten): untested. The module needs to make an
  outbound WebSocket connection to your relay — it may work; reports
  welcome in the issue tracker.

### ⚠️ The generated-secrets page — write these down

The wizard generates four secrets and shows them **exactly once**:

| Secret | You'll need it when |
|---|---|
| Foundry admin key | Unlocking Foundry's setup screen (step 3) |
| Companion user password | Creating the app's GM user in your world (step 4) |
| Relay account password | Approving the pairing (step 5) |
| App admin password | Opening the app's `/admin` console (step 6) |

*Bring-your-own installs only get the last two secrets (relay account + app
admin passwords). The Companion password is one you chose yourself in section
2b, and there is no Foundry admin key.*

Save them, then confirm — the stack starts. First boot downloads Foundry
(a few minutes). Watch progress at `http://<your-ip>:8321`.

## 3. First-time Foundry setup

*Bundled setups only — connected to an existing Foundry? You did this in section 2b; skip to section 5.*

Open `http://<your-ip>:30000`.

1. Accept the license/EULA (your key was fetched automatically).
2. If prompted for the admin password, use the **Foundry admin key** from
   the secrets page.
3. Install the game system you play (e.g. "D&D Fifth Edition") under
   **Game Systems → Install System**.
4. Create your world and launch it.

## 4. Create the Companion user

*Bundled setups only — connected to an existing Foundry? You did this in section 2b; skip to section 5.*

The app logs into your world through a dedicated GM user, so YOUR
Gamemaster seat stays free (Foundry allows one session per user).

In your world: **Settings → User Management**, create a user named exactly
`Companion` with role **Gamemaster**, and set its password to the
**Companion user password** from the secrets page.

## 5. Connect the module (order matters!)

Bundled setups find the "Foundry REST API" module already installed; BYO users
installed it in section 2b. Either way, you now enable and point it:

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

**Updating from v0.2.x or earlier?** Run `make update` twice — the first run updates the
updater itself, the second applies the new compose profile migration. If
compose warns about an orphaned foundry container in between, ignore it (do
NOT use `--remove-orphans`); your world data is untouched.

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
| Pairing fails with "TypeError: Failed to fetch" | The relay isn't reachable from your browser at the module's URL — the companion stack may be down, or the host/port in the URL is wrong. Check the URL matches the admin panel's value and that `http://<same-host>:3010` opens in a browser tab. |
| Module shows "Paired" but with a URL mismatch warning | The stored pairing belongs to a different relay URL (e.g. after changing the module URL). Click **Unpair**, then **Pair** again against the new URL. |
| "Copy" buttons in the app do nothing | Browsers only allow clipboard access on HTTPS or localhost. Select and copy the text manually, or set up TLS (section 8). |
| Port already in use on startup | Something else uses 8080/30000/3010/8321. Change `HOST_PORT_*` in `.env` and `docker compose up -d`. |
| Foundry asks for credentials again after a reboot and no world loads | Set `FOUNDRY_WORLD=<your-world-id>` in `.env` so the world auto-launches, then `docker compose up -d`. |
| "This license key is already in use" | Your license is active on another server. Stop the other Foundry first. |
| Wizard link unreachable on a remote server | Tunnel it: `ssh -L 8322:localhost:8322 <host>`, then open `http://localhost:8322/s/<token>/`. |
| BYO mode: players drop when I close my browser | The Companion user keeps the world alive only while the world is running and the credentials are correct — check the status page (`:8321`) and that the Companion user exists with the exact password you entered. |

Logs are your friend: `docker compose logs -f gateway` (or `relay`,
`bootstrap`, `web`). The `foundry` log only exists on bundled installs — BYO
setups have no `foundry` container here at all; check your own Foundry's logs
instead.

With an external Foundry plus the TLS profile (section 8), the `vtt.<domain>`
proxy target doesn't exist — leave that DNS record unconfigured, or expect a
502 there.

## 10. Getting help

Open an issue: https://github.com/Tenezill/unseen-servant/issues — include
your OS, how you installed Docker, and the relevant `docker compose logs`
output (never paste your `secrets/` files).
