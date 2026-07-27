/**
 * Turnkey quickstart setup (spec Phase 1, host-side by design: writing files
 * and running `compose up` from the host needs no runtime socket and no
 * restart choreography). Prompts for the MINIMUM (foundry.com credentials;
 * optionally TLS domains), GENERATES everything else (base64url — symbol-
 * safe by construction), writes stack/quickstart config + secret files
 * (0600), prints the generated secrets ONCE, and runs compose up.
 * Idempotent: existing files are kept (secrets never re-echoed); --reset
 * wipes generated files (volumes untouched); --no-up skips the compose run.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createWizard } from './setup-wizard.mjs';
import { networkInterfaces } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
// Cycle note: update-stack.mjs imports resolveQuickstartDir/detectComposeCommand
// from THIS file. Both sides only reference `export function` declarations
// (hoisted at module-instantiation time, before either body evaluates), so
// the cycle resolves cleanly — verified by the full test suite staying green.
import { planEnvMigration } from './update-stack.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Private repo: quickstart lives at stack/quickstart. Public quickstart repo:
 * the compose file sits at the repo root (scripts/ next to it). Everything
 * downstream (secrets, .env, bind-mount dirs, compose cwd) hangs off this.
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveQuickstartDir(repoRoot) {
  const nested = join(repoRoot, 'stack', 'quickstart');
  return existsSync(join(nested, 'docker-compose.yml')) ? nested : repoRoot;
}

const QDIR = resolveQuickstartDir(REPO_ROOT);
const SECRETS = join(QDIR, 'secrets');

export function generateSecret(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export function buildFoundryConfigJson({ username, password, licenseKey, adminKey }) {
  // Key names per Task 0 findings §2 (felddy 13.351.0 secrets file).
  const cfg = { foundry_username: username, foundry_password: password };
  if (licenseKey !== '') cfg.foundry_license_key = licenseKey;
  cfg.foundry_admin_key = adminKey;
  return JSON.stringify(cfg, null, 2) + '\n';
}

export function buildBootstrapEnv({ relayEmail, relayPassword, gmUser, gmPassword, adminKey }) {
  const lines = [
    `RELAY_ACCOUNT_EMAIL=${relayEmail}`,
    `RELAY_ACCOUNT_PASSWORD=${relayPassword}`,
    `FOUNDRY_GM_USER=${gmUser}`,
    `FOUNDRY_GM_PASSWORD=${gmPassword}`,
  ];
  // BYO mode has no admin key (world auto-relaunch is bundled-only — see the
  // spec's ADMIN_RELAUNCH amendment); omit the line rather than write empty.
  if (adminKey !== undefined && adminKey !== '') lines.push(`FOUNDRY_ADMIN_KEY=${adminKey}`);
  return lines.join('\n') + '\n';
}

export function buildGatewayEnv({ adminPassword }) {
  return `ADMIN_PASSWORD=${adminPassword}\n`;
}

/** foundry: {mode:'bundled'} | {mode:'external', url} — drives which services
 *  compose starts (COMPOSE_PROFILES) and where the bootstrap sidecar looks. */
export function buildDotEnv({ tls, publicHost, foundry }) {
  const lines = ['HOST_PORT_WEB=8080', 'HOST_PORT_FOUNDRY=30000', 'HOST_PORT_RELAY=3010', 'HOST_PORT_STATUS=8321'];
  const profiles = [];
  if (foundry.mode === 'bundled') profiles.push('foundry');
  if (tls) {
    profiles.push('tls');
    lines.push('FOUNDRY_PROXY_SSL=true', 'FOUNDRY_PROXY_PORT=443');
  }
  if (profiles.length > 0) lines.push(`COMPOSE_PROFILES=${profiles.join(',')}`);
  if (foundry.mode === 'external') {
    lines.push('FOUNDRY_MODE=external', `FOUNDRY_URL=${foundry.url}`);
  } else {
    // Auto-launch your world on start/reboot — fill in the world id once it exists:
    lines.push('# FOUNDRY_WORLD=your-world-id');
  }
  // The URL the GM's browser uses to reach the relay: pairing approvals open
  // RELAY_PUBLIC_URL/pair/<code> on YOUR relay (not foundryrestapi.com), and
  // the admin panel derives the module's ws:// URL from it. Always http — the
  // relay is never behind the Caddy TLS proxy (E2E finding 3).
  lines.push(`RELAY_PUBLIC_URL=http://${publicHost}:3010`);
  return lines.join('\n') + '\n';
}

export function buildTlsCaddyfile({ domainApp, domainVtt, acmeEmail }) {
  const template = readFileSync(join(QDIR, 'Caddyfile.tls.example'), 'utf8');
  return template
    .replaceAll('{{DOMAIN_APP}}', domainApp)
    .replaceAll('{{DOMAIN_VTT}}', domainVtt)
    .replaceAll('{{ACME_EMAIL}}', acmeEmail);
}

export function detectComposeCommand(run = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' })) {
  if (run('docker', ['compose', 'version']).status === 0) return ['docker', 'compose'];
  if (run('podman', ['compose', 'version']).status === 0) return ['podman', 'compose'];
  if (run('podman-compose', ['version']).status === 0) return ['podman-compose'];
  return null;
}

export const PODMAN_OVERRIDE_MARKER = '# generated by `make setup` (rootless-Podman)';

// Bind-mount source dirs for the quickstart stack. Rootless Podman (crun) does
// not auto-create them like Docker does, so `make setup` pre-creates them.
export const QUICKSTART_BIND_DIRS = ['foundry_data', 'relay-data', 'gateway-data', 'caddy-data', 'companion-runtime'];

/** Bind dirs to pre-create — the SAME full list for both modes. An external
 *  install's ./foundry_data sits empty (the foundry service is never part of
 *  the active compose profile, so nothing reads or writes it), but rootless
 *  Podman needs every bind-mount SOURCE dir to exist up front regardless of
 *  which profile is active, or `compose up` aborts. The empty dir is
 *  harmless, so pre-create it unconditionally rather than special-case it. */
export function quickstartBindDirs(mode) {
  return QUICKSTART_BIND_DIRS;
}

export function isPodmanRuntime(compose) {
  return Array.isArray(compose) && compose[0].startsWith('podman');
}

// The felddy foundry image runs as this fixed non-root uid on the docker
// path; root-created bind mounts / 0600 secrets are unreadable to it and the
// container aborts (felddy/foundryvtt-docker discussion #1197 — E2E findings
// 1+2). Rootless Podman is exempt: keep-id (see buildPodmanComposeOverride)
// maps the container uid to the host user, so host ownership is already right.
export const FOUNDRY_CONTAINER_UID = 1000;

/**
 * Pure plan (testable) for aligning ownership with the container uid.
 * @param {{platform: string, euid: number, isPodman: boolean, qdir: string}} p
 * @returns {{chowns: string[][], warning: string|null}}
 */
export function planOwnershipFixes({ platform, euid, isPodman, qdir }) {
  const none = { chowns: [], warning: null };
  if (platform !== 'linux' || isPodman) return none;
  // Always posix-joined: this models paths on the Linux container host (the
  // `platform !== 'linux'` guard above), independent of the OS running setup
  // (e.g. these tests execute under Windows Node, where `join` would emit `\`).
  const targets = [posix.join(qdir, 'foundry_data'), posix.join(qdir, 'secrets', 'foundry-config.json')];
  const owner = `${FOUNDRY_CONTAINER_UID}:${FOUNDRY_CONTAINER_UID}`;
  if (euid === 0) return { chowns: [['chown', '-R', owner, ...targets]], warning: null };
  if (euid === FOUNDRY_CONTAINER_UID) return none;
  return {
    chowns: [],
    warning:
      `the foundry container runs as uid ${FOUNDRY_CONTAINER_UID} and must own its data dir and secret, ` +
      `but setup is running as uid ${euid} and cannot fix that.\n` +
      `  Run:  sudo chown -R ${owner} ${targets.join(' ')}\n` +
      `  then re-run \`make setup\` (or restart the stack).`,
  };
}

// felddy foundry runs as a fixed non-root uid; under rootless Podman the host
// user maps to container-root, so foundry (uid 1000) cannot read/write the
// host-owned bind mount or the 0600 secret. keep-id maps its uid to the host
// user, fixing both — and keeping the secret readable by the host user too.
// ONLY foundry needs this: relay/gateway/web/bootstrap run as root (or start as
// root and self-chown), which already maps to the host user under rootless Podman.
export function buildPodmanComposeOverride() {
  return (
    `${PODMAN_OVERRIDE_MARKER} — do not edit; auto-removed on the docker path.\n` +
    'services:\n' +
    '  foundry:\n' +
    '    userns_mode: "keep-id"\n'
  );
}

function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '<this-host-ip>';
}

export function writeSecretIfAbsent(path, content) {
  if (existsSync(path)) return false;
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows dev box */
  }
  return true;
}

/** Generate + write the secret files (0600, keep-if-present) and return the
 *  operator-facing generated secrets as [label, value]. creds.mode defaults
 *  to 'bundled' (felddy foundry.com credentials); 'external' (BYO) skips the
 *  foundry-config.json / admin key — the operator entered Companion's
 *  credentials for their own world. */
export function writeSecretsBundle(creds, dirs = { secrets: SECRETS }) {
  const relayPassword = generateSecret();
  const adminPassword = generateSecret();
  if (creds.mode === 'external') {
    // BYO: Companion credentials are ENTERED by the operator (they created
    // the user in their world); no felddy config, no admin key.
    writeSecretIfAbsent(
      join(dirs.secrets, 'bootstrap.env'),
      buildBootstrapEnv({
        relayEmail: 'bootstrap@companion.local',
        relayPassword,
        gmUser: creds.gmUser,
        gmPassword: creds.gmPassword,
      }),
    );
    writeSecretIfAbsent(join(dirs.secrets, 'gateway.env'), buildGatewayEnv({ adminPassword }));
    return [
      ['Relay account (bootstrap@companion.local)', relayPassword],
      ['App admin console password (/admin)', adminPassword],
    ];
  }
  // bundled (existing behavior)
  const adminKey = generateSecret();
  writeSecretIfAbsent(
    join(dirs.secrets, 'foundry-config.json'),
    buildFoundryConfigJson({ username: creds.username, password: creds.password, licenseKey: creds.licenseKey, adminKey }),
  );
  // The headless keep-alive session logs in as a DEDICATED "Companion" user, not
  // Gamemaster — Foundry allows one session per user, so sharing Gamemaster would
  // lock the operator out (or vice-versa). The operator creates a Gamemaster-role
  // user named "Companion" with this password (one-time, see the Next steps).
  const companionPassword = generateSecret();
  writeSecretIfAbsent(
    join(dirs.secrets, 'bootstrap.env'),
    buildBootstrapEnv({
      relayEmail: 'bootstrap@companion.local',
      relayPassword,
      gmUser: 'Companion',
      gmPassword: companionPassword,
      adminKey,
    }),
  );
  writeSecretIfAbsent(join(dirs.secrets, 'gateway.env'), buildGatewayEnv({ adminPassword }));
  return [
    ['Foundry admin key (setup screen)', adminKey],
    ['Companion user password (create a Gamemaster-role user named "Companion" with this)', companionPassword],
    ['Relay account (bootstrap@companion.local)', relayPassword],
    ['App admin console password (/admin)', adminPassword],
  ];
}

/** Write .env (+ Caddyfile.tls when TLS is enabled). tls: {enabled, domainApp?, domainVtt?, acmeEmail?}, publicHost: string, foundry: {mode:'bundled'} | {mode:'external', url} */
export function writeEnvFiles(tls, publicHost, foundry, dirs = { qdir: QDIR }) {
  if (tls.enabled) {
    writeFileSync(
      join(dirs.qdir, 'Caddyfile.tls'),
      buildTlsCaddyfile({ domainApp: tls.domainApp, domainVtt: tls.domainVtt, acmeEmail: tls.acmeEmail }),
      'utf8',
    );
  }
  writeFileSync(join(dirs.qdir, '.env'), buildDotEnv({ tls: tls.enabled, publicHost, foundry }), 'utf8');
}

/** Mode of an existing install, from its .env; null = no .env (fresh). */
export function detectInstalledMode(qdir) {
  const envPath = join(qdir, '.env');
  if (!existsSync(envPath)) return null;
  return /^FOUNDRY_MODE=external\r?$/m.test(readFileSync(envPath, 'utf8')) ? 'external' : 'bundled';
}

function printGeneratedSecrets(generated) {
  console.log('\n================ GENERATED SECRETS — SHOWN ONCE, WRITE THEM DOWN ================');
  for (const [label, value] of generated) console.log(`  ${label}:\n      ${value}`);
  console.log('==================================================================================\n');
}

async function main() {
  const args = process.argv.slice(2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let wizard = null;
  try {
    if (args.includes('--reset')) {
      const sure = (await rl.question('Delete generated quickstart config + secrets (volumes untouched)? [y/N] ')).trim();
      if (sure.toLowerCase() !== 'y') return;
      for (const f of ['.env', 'Caddyfile.tls', 'docker-compose.override.yml']) rmSync(join(QDIR, f), { force: true });
      if (existsSync(SECRETS)) {
        for (const f of ['foundry-config.json', 'bootstrap.env', 'gateway.env']) rmSync(join(SECRETS, f), { force: true });
      }
      console.log('reset done — run `make setup` to start over.');
      return;
    }

    mkdirSync(SECRETS, { recursive: true });
    try {
      chmodSync(SECRETS, 0o700);
    } catch {
      /* windows dev box */
    }

    // Mode: an existing .env decides; otherwise ask (terminal path asks below,
    // the web wizard asks in its form — both write it into .env).
    const installedMode = detectInstalledMode(QDIR);

    // Self-heal the v0.1.x-v0.2.x -> v0.3.0 compose-profile migration right here, not
    // just in `make update`: an OLD (pre-migration) update-stack.mjs pulls the
    // new compose file in-process but has no idea it needs to add
    // COMPOSE_PROFILES=foundry, silently orphaning the bundled foundry
    // container until a SECOND `make update` runs the NEW updater. Since
    // `make setup` is re-run after every update (idempotent by design), this
    // heals it a run earlier.
    const envPath = join(QDIR, '.env');
    if (existsSync(envPath)) {
      const migrated = planEnvMigration(readFileSync(envPath, 'utf8'), existsSync(join(SECRETS, 'foundry-config.json')));
      if (migrated !== null) {
        writeFileSync(envPath, migrated, 'utf8');
        console.log('migrated .env: bundled foundry now runs under COMPOSE_PROFILES=foundry (v0.3.0).');
      }
    }

    const needTls = installedMode === null;
    let mode = installedMode ?? 'bundled';
    const needCreds =
      installedMode === 'external'
        ? !existsSync(join(SECRETS, 'bootstrap.env'))
        : !existsSync(join(SECRETS, 'foundry-config.json'));
    const ip = lanIp();
    let generated = [];

    if (!needCreds) {
      console.log('secrets already present — keeping them (use `make setup-reset` to regenerate).');
    }

    // Ephemeral web wizard (spec Phase 2, Approach A): hosted in THIS process,
    // so it dies with the CLI — one-time token + auto-disable are structural.
    // Raced against terminal-Enter; --no-wizard or a failed listen (port in
    // use) falls back to the terminal prompts. Never expose it when there is
    // nothing to collect.
    if ((needCreds || needTls) && !args.includes('--no-wizard')) {
      const w = createWizard({
        token: generateSecret(),
        needCreds,
        needTls,
        needMode: installedMode === null,
        defaultMode: mode,
        defaultPublicHost: ip,
        bgPath: join(REPO_ROOT, 'scripts', 'assets', 'unseen-servant.jpg'),
        statusUrl: `http://${ip}:8321/`,
        onSubmit: async ({ creds, tls, publicHost, foundry }) => {
          // Must stay synchronous (no awaits before the writes): main() resumes
          // on the next microtask and runs the ownership chown — a secret
          // written after that point would stay root-owned (E2E finding 2).
          // Thread the submitted mode back into main()'s scope: the bind-dir
          // creation, ownership chown, and next-steps text below all read the
          // outer `mode`, which otherwise still held its pre-wizard value for
          // a browser-driven submission (this closure runs fully sync, before
          // Promise.race below observes `wizard.submitted` — see the comment
          // above — so this assignment is visible by the time main() resumes).
          mode = foundry?.mode ?? mode;
          if (creds !== null) generated = writeSecretsBundle(creds);
          if (needTls) writeEnvFiles(tls, publicHost ?? ip, foundry ?? { mode: 'bundled' });
          if (generated.length > 0) printGeneratedSecrets(generated); // terminal backup, both paths
          return generated;
        },
      });
      try {
        await w.listen(8322, '0.0.0.0');
        wizard = w;
      } catch (err) {
        console.error(`wizard could not start (${err.code ?? err.message}) — using terminal prompts.`);
      }
    }

    if (wizard !== null) {
      console.log(`\nOpen  http://${ip}:8322/s/${wizard.token}/  in a browser on your network`);
      console.log('to finish setup — or press Enter here to use terminal prompts instead.');
      console.log('(remote server? tunnel first:  ssh -L 8322:localhost:8322 <host>)');
      const ac = new AbortController();
      const enter = rl.question('', { signal: ac.signal }).then(
        () => 'terminal',
        () => 'aborted', // AbortError when the browser wins
      );
      const winner = await Promise.race([wizard.submitted, enter]);
      if (winner === 'terminal') {
        wizard.takeover();
        wizard.close();
        wizard = null;
      } else {
        ac.abort();
      }
    }

    if (wizard === null && (needCreds || needTls)) {
      // Gated on needCreds too (mirrors the web wizard's radio gate, which
      // only renders when `needCreds && needMode`): with needCreds false
      // there is nothing to collect for either mode, so asking is not just
      // moot — the answer is then never applied, leaving `foundry.url`
      // unset and writing a literal "FOUNDRY_URL=undefined" into .env.
      if (installedMode === null && needCreds) {
        const byo = (await rl.question('Connect to an EXISTING Foundry server instead of running one here? [y/N] '))
          .trim()
          .toLowerCase() === 'y';
        mode = byo ? 'external' : 'bundled';
      }
      let foundry = { mode };
      if (needCreds) {
        if (mode === 'external') {
          console.log('Your existing Foundry (see GUIDE.md "Connect an existing Foundry"):');
          let url = '';
          while (url === '') {
            url = (await rl.question('  Foundry URL as reachable FROM THIS MACHINE (e.g. http://192.168.1.9:30000): ')).trim();
            if (url !== '' && !/^https?:\/\//.test(url)) {
              console.log('  please include the scheme (http:// or https://)');
              url = '';
            }
          }
          if (url.startsWith('https://')) {
            console.log('  NOTE: an https Foundry blocks the module\'s ws:// relay connection (mixed');
            console.log('  content) — you will need the relay behind your own TLS proxy. See GUIDE.md.');
          }
          foundry = { mode: 'external', url };
          console.log('  Create a Gamemaster-role user for the app in your world first (one session per user):');
          const gmUser = (await rl.question('  Companion user name [Companion]: ')).trim() || 'Companion';
          const gmPassword = await rl.question('  Companion user password (input is visible): ');
          generated = writeSecretsBundle({ mode: 'external', gmUser, gmPassword });
        } else {
          console.log('foundry.com credentials (used by the container to download Foundry):');
          const username = (await rl.question('  foundry.com username/email: ')).trim();
          const password = await rl.question('  foundry.com password (input is visible): ');
          const licenseKey = (await rl.question('  license key (Enter = fetch from the account): ')).trim();
          generated = writeSecretsBundle({ username, password, licenseKey });
        }
      }
      if (needTls) {
        const wantTls = (await rl.question('Enable HTTPS on your own domain? [y/N] ')).trim().toLowerCase() === 'y';
        const tls = { enabled: wantTls };
        if (wantTls) {
          tls.domainApp = (await rl.question('  app domain (e.g. app.example.com): ')).trim();
          tls.domainVtt = (await rl.question('  foundry domain (e.g. vtt.example.com): ')).trim();
          tls.acmeEmail = (await rl.question("  email for Let's Encrypt: ")).trim();
        }
        const defaultHost = wantTls ? tls.domainApp || ip : ip;
        const answered = (await rl.question(`Where will you (the GM) reach this server? [${defaultHost}]: `)).trim();
        writeEnvFiles(tls, answered === '' ? defaultHost : answered, foundry);
      }
      if (generated.length > 0) printGeneratedSecrets(generated);
    }

    console.log('Next steps once the stack is up:');
    if (mode === 'external') {
      console.log('  1. In YOUR Foundry: install the "Foundry REST API" module (see GUIDE.md).');
      console.log(`  2. Enable the module, set its WebSocket Relay URL to ws://${ip}:3010 BEFORE`);
      console.log('     clicking Pair, then launch the world and pair.');
    } else {
      console.log(`  1. Foundry:      http://${ip}:30000  (EULA once, admin key above, create YOUR world)`);
      console.log('  2. In the world: create a Gamemaster-role user named "Companion" with the');
      console.log('     Companion password above (this is the app’s headless login — keeps YOUR');
      console.log('     Gamemaster seat free). Then enable the "Foundry REST API" module, set its');
      console.log(`     WebSocket Relay URL to ws://${ip}:3010, launch the world, and pair.`);
    }
    console.log(`  3. Watch:        http://${ip}:8321  (setup status page)`);
    console.log(`  4. Play:         http://${ip}:8080  — invite players via /admin`);

    const compose = detectComposeCommand();

    // Rootless Podman (crun) does not auto-create bind-mount source dirs the way
    // Docker does — pre-create them (as the host user) so `compose up` doesn't
    // abort with "cannot stat …/relay-data". Harmless and idempotent on Docker.
    for (const d of quickstartBindDirs(mode)) mkdirSync(join(QDIR, d), { recursive: true });

    // Rootless-Podman ownership fix: give foundry keep-id via a generated
    // override (Podman only). Managed even under --no-up so a later manual
    // `podman compose up` still gets it. Removed on the docker path, but only
    // if we generated it (never clobber a user-authored override).
    const override = join(QDIR, 'docker-compose.override.yml');
    if (isPodmanRuntime(compose)) {
      writeFileSync(override, buildPodmanComposeOverride(), 'utf8');
      console.log('rootless-Podman detected → wrote docker-compose.override.yml (foundry keep-id).');
    } else if (existsSync(override) && readFileSync(override, 'utf8').startsWith(PODMAN_OVERRIDE_MARKER)) {
      rmSync(override, { force: true });
    }

    // E2E findings 1+2: align ownership with the foundry container's uid.
    // External mode has nothing to chown (no foundry_data, no foundry-config.json).
    const ownership =
      mode === 'external'
        ? { chowns: [], warning: null }
        : planOwnershipFixes({
            platform: process.platform,
            euid: typeof process.getuid === 'function' ? process.getuid() : -1,
            isPodman: isPodmanRuntime(compose),
            qdir: QDIR,
          });
    for (const cmd of ownership.chowns) {
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
      if (r.status !== 0) {
        console.warn(`\nWARNING: ${cmd.join(' ')} failed — the foundry container may not be able to read its data dir or secret. Fix ownership manually and re-run \`make setup\`.`);
      }
    }
    if (ownership.warning !== null) console.warn(`\nWARNING: ${ownership.warning}`);

    if (args.includes('--no-up')) {
      wizard?.close();
      return;
    }
    if (compose === null) {
      console.error('no container runtime found — install docker (with compose v2) or podman.');
      process.exitCode = 1;
      wizard?.close();
      return;
    }
    console.log(`\nrunning: ${compose.join(' ')} up -d --build   (in ${QDIR})`);
    if (wizard !== null) {
      // Browser path: the "I've written these down" click gates compose, and
      // compose runs async so the wizard can keep serving the progress page.
      await wizard.acked;
      const code = await new Promise((resolve) => {
        const child = spawn(compose[0], [...compose.slice(1), 'up', '-d', '--build'], { cwd: QDIR, stdio: 'inherit' });
        child.on('close', (c) => resolve(c ?? 1));
        child.on('error', () => resolve(1));
      });
      wizard.setPhase(code === 0 ? 'done' : 'failed', { exitCode: code });
      process.exitCode = code;
      await wizard.waitForFinalPage(30_000); // bounded — let the browser land on the redirect page
      wizard.close();
      wizard = null;
    } else {
      const up = spawnSync(compose[0], [...compose.slice(1), 'up', '-d', '--build'], { cwd: QDIR, stdio: 'inherit' });
      process.exitCode = up.status ?? 1;
    }
  } finally {
    rl.close();
    wizard?.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('setup failed:', err.message);
    process.exit(1);
  });
}
