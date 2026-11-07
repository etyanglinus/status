#!/usr/bin/env node
// Upgrade an existing Fasta Status deployment:  npm run update
// Applies new database migrations, refreshes recommended settings in wrangler.toml, and redeploys.
// Your data, operator logins and alert settings are kept.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WIN = process.platform === 'win32';
const g = (s) => `\x1b[32m${s}\x1b[0m`, r = (s) => `\x1b[31m${s}\x1b[0m`, b = (s) => `\x1b[1m${s}\x1b[0m`;
const run = (args) => spawnSync(WIN ? 'npx.cmd' : 'npx', ['wrangler', ...args], { stdio: 'inherit', shell: WIN }).status === 0;

const staging = process.argv.includes('--staging');
const CONFIG = staging ? 'wrangler.staging.toml' : 'wrangler.toml';
if (!existsSync(CONFIG)) {
  console.error(r(`\n✖ ${CONFIG} not found.`) + `\n  This folder has not been set up yet. Run ${b('npm run setup')} first.\n  (If you unzipped a new version into a new folder, copy your old ${CONFIG} into it.)\n`);
  process.exit(1);
}
if (!existsSync(join(ROOT, 'node_modules', 'wrangler'))) {
  console.log('Installing dependencies…');
  if (spawnSync(WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: WIN }).status !== 0) process.exit(1);
}

let toml = readFileSync(CONFIG, 'utf8');
const db = toml.match(/database_name = "([^"]+)"/)?.[1];
if (!db) { console.error(r(`✖ No database_name in ${CONFIG}.`)); process.exit(1); }

// Bring older configs up to the current recommended settings.
const changes = [];
if (/^SLOW_RESPONSE_MS = "4000"/m.test(toml)) { toml = toml.replace(/^SLOW_RESPONSE_MS = "4000".*$/m, 'SLOW_RESPONSE_MS = "5000"'); changes.push('slow-response limit 4 s → 5 s'); }
if (!/^CATALOGUE_ZONE_IDS/m.test(toml) && /^CATALOGUE_CHECK/m.test(toml)) { toml = toml.replace(/^(CATALOGUE_CHECK = .*)$/m, '$1\nCATALOGUE_ZONE_IDS = "[1]"'); changes.push('added CATALOGUE_ZONE_IDS'); }
if (changes.length) {
  copyFileSync(CONFIG, `${CONFIG}.bak`);
  writeFileSync(CONFIG, toml);
  console.log(g(`✔ Updated ${CONFIG}: ${changes.join(', ')} (old copy saved as ${CONFIG}.bak)`));
}

console.log(b('\n1. Upgrading the database'));
if (!run(['d1', 'migrations', 'apply', db, '--remote', '-c', CONFIG])) { console.error(r('✖ Database upgrade failed. Nothing was deployed; the live page is unchanged.')); process.exit(1); }
console.log(b('\n2. Deploying the new version'));
if (!run(['deploy', '-c', CONFIG])) { console.error(r('✖ Deploy failed. The database upgrade is applied; fix the error above and run npm run update again.')); process.exit(1); }
const host = toml.match(/pattern = "([^"]+)"/)?.[1];
console.log(g(b('\n✔ Updated.')) + (host ? ` Open https://${host} (allow 1–2 minutes for the first new checks).` : ''));
