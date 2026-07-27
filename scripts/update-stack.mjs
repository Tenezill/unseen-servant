/**
 * Data-safe updater for the turnkey stack (docs/HOSTING.md Part C).
 *
 * Pulls the latest code, refreshes/rebuilds images, and recreates only the
 * containers whose image or config changed. It NEVER touches the host
 * bind-mount state — your world, players.yaml, secrets and the relay DB all
 * live in ./stack/quickstart/{foundry_data,relay-data,gateway-data,...} and are
 * simply reattached. No `down`, no `-v`, no volume/dir removal. Idempotent:
 * re-running with nothing new is a no-op restart.
 *
 *   node scripts/update-stack.mjs            # git pull + compose pull + up -d --build
 *   node scripts/update-stack.mjs --no-pull  # skip git pull (rebuild/restart only)
 *
 * (No shebang on purpose — a `#!` line breaks vitest's .mjs import.)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { detectComposeCommand, resolveQuickstartDir } from './setup-quickstart.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QDIR = resolveQuickstartDir(REPO_ROOT);

/** Tokens that would destroy state — this updater must NEVER emit them. */
export const DESTRUCTIVE_TOKENS = ['down', '-v', '--volumes', 'rm', 'prune', 'stop'];

/**
 * One-time v0.3.0 migration: the bundled foundry service moved behind the
 * `foundry` compose profile. A pre-v0.3.0 .env has no COMPOSE_PROFILES (or
 * only `tls`) — composing with it would silently DROP the operator's Foundry
 * container. Evidence of a bundled install = secrets/foundry-config.json.
 * Returns the full corrected .env text, or null when nothing must change.
 * BYO installs (FOUNDRY_MODE=external) are never touched.
 *
 * Handles duplicate COMPOSE_PROFILES lines (dotenv/compose use last-wins
 * semantics): only rewrites the LAST occurrence; earlier duplicates are left
 * inert. Preserves CRLF line endings for consistent file style.
 */
export function planEnvMigration(envText, hasFoundryConfig) {
  if (envText === null || !hasFoundryConfig) return null;
  if (/^FOUNDRY_MODE=external\r?$/m.test(envText)) return null;

  // Find ALL COMPOSE_PROFILES lines (last-wins semantics in dotenv/compose)
  const matches = [...envText.matchAll(/^COMPOSE_PROFILES=(.*)$/gm)];

  if (matches.length === 0) {
    // No COMPOSE_PROFILES line; append one with appropriate line endings
    const hasCRLF = /\r\n/.test(envText);
    const eol = hasCRLF ? '\r\n' : '\n';
    return envText.replace(/\r?\n?$/, '') + eol + 'COMPOSE_PROFILES=foundry' + eol;
  }

  // Operate on the LAST match only (earlier duplicates stay unchanged)
  const lastMatch = matches[matches.length - 1];
  const profileValue = lastMatch[1].replace(/\r$/, ''); // Strip trailing \r for parsing
  const profiles = profileValue.split(',').map((p) => p.trim()).filter((p) => p !== '');

  if (profiles.includes('foundry')) return null;

  // Build new profile list with foundry first
  const newProfiles = ['foundry', ...profiles].join(',');
  const newLine = `COMPOSE_PROFILES=${newProfiles}`;

  // Replace only the LAST COMPOSE_PROFILES line; keep earlier duplicates unchanged
  let matchCount = 0;
  return envText.replace(/^COMPOSE_PROFILES=(.*)$/gm, (match) => {
    matchCount++;
    return matchCount === matches.length ? newLine : match;
  });
}

/**
 * The ordered, data-safe steps for an update. Pure (no side effects) so the
 * safety guarantee is unit-testable: none of these removes a container,
 * volume, or bind mount.
 * @param {string[]} compose e.g. ['docker','compose']
 * @param {{ pull?: boolean, cwd?: string, qdir?: string }} [opts]
 * @returns {{ label: string, cwd: string, cmd: string[] }[]}
 */
export function buildUpdateSteps(compose, { pull = true, cwd = REPO_ROOT, qdir = QDIR } = {}) {
  const steps = [];
  // Fast-forward only: refuse to silently merge/rebase divergent local commits.
  if (pull) steps.push({ label: 'pull latest code', cwd, cmd: ['git', 'pull', '--ff-only'] });
  // Refresh pinned upstream images (foundry, relay). Build-only services are skipped.
  steps.push({ label: 'pull updated images', cwd: qdir, cmd: [...compose, 'pull'] });
  // Rebuild locally-built images (gateway/web/bootstrap) and recreate ONLY the
  // containers whose image/config changed. Bind mounts are reattached as-is.
  steps.push({ label: 'rebuild & restart', cwd: qdir, cmd: [...compose, 'up', '-d', '--build'] });
  return steps;
}

/** True if any step would destroy state — a defensive backstop. */
export function hasDestructiveStep(steps) {
  return steps.some((s) => s.cmd.some((t) => DESTRUCTIVE_TOKENS.includes(t)));
}

/**
 * Guards the re-exec-after-pull pattern (future releases): `git pull` can
 * bring down a NEWER update-stack.mjs than the one currently running, which
 * would otherwise keep running its OLD migration/step logic for the rest of
 * this invocation — exactly the "first update doesn't apply, second update
 * does" gap this release closes for the v0.1.x-v0.2.x -> v0.3.0 jump. Once pull has
 * happened, hand off to the freshly-pulled on-disk script via `spawnSync`
 * (`--no-pull`, so the child does not pull again) — guarded by
 * UPDATE_STACK_REEXEC so it can only fire once even if the child's own logic
 * changes in a later release.
 * @param {string[]} argv e.g. process.argv
 * @param {Record<string, string | undefined>} env e.g. process.env
 * @returns {boolean}
 */
export function shouldReexec(argv, env) {
  return !argv.includes('--no-pull') && env.UPDATE_STACK_REEXEC !== '1';
}

function runSteps(steps) {
  for (const s of steps) {
    console.log(`\n→ ${s.label}: ${s.cmd.join(' ')}${s.cwd ? `  (in ${s.cwd})` : ''}`);
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: s.cwd, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`\n✗ step failed: ${s.cmd.join(' ')} (exit ${r.status ?? 'signal'})`);
      console.error('  Your data was NOT touched. Fix the cause and re-run `make update`.');
      process.exit(r.status ?? 1);
    }
  }
}

function applyEnvMigration() {
  const envPath = join(QDIR, '.env');
  const migrated = planEnvMigration(
    existsSync(envPath) ? readFileSync(envPath, 'utf8') : null,
    existsSync(join(QDIR, 'secrets', 'foundry-config.json')),
  );
  if (migrated !== null) {
    writeFileSync(envPath, migrated, 'utf8');
    console.log('migrated .env: bundled foundry now runs under COMPOSE_PROFILES=foundry (v0.3.0).');
  }
}

function main() {
  const pull = !process.argv.includes('--no-pull');
  const compose = detectComposeCommand();
  if (compose === null) {
    console.error('no container runtime found — install docker (with compose v2) or podman.');
    process.exit(1);
  }
  const steps = buildUpdateSteps(compose, { pull });
  if (hasDestructiveStep(steps)) {
    // Should be unreachable; guarantees we never nuke state even after edits.
    console.error('refusing to run: update plan contained a destructive step.');
    process.exit(1);
  }
  console.log('Updating the stack — world, players, secrets and data are preserved (host bind mounts untouched).');

  if (pull) {
    // Run `git pull` alone first, THEN decide whether to hand off — a step
    // later in `steps` may already belong to a newer script than this one.
    runSteps([steps[0]]);
    if (shouldReexec(process.argv, process.env)) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--no-pull'], {
        stdio: 'inherit',
        env: { ...process.env, UPDATE_STACK_REEXEC: '1' },
      });
      process.exit(child.status ?? 1);
    }
    // Only reachable if the re-exec guard already fired (defensive — normal
    // runs always hand off above); still apply the migration ourselves so
    // remaining steps see a corrected .env either way.
    applyEnvMigration();
    runSteps(steps.slice(1));
  } else {
    applyEnvMigration();
    runSteps(steps);
  }
  console.log('\n✓ Update complete. Nothing in your setup was reset.');
}

// Run only when invoked directly, never when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
