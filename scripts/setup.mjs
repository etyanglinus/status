#!/usr/bin/env node
// Fasta Status one-command setup:  npm run setup
// Creates the database, sets operator logins and alerts, and deploys to your Cloudflare account.
// Safe to re-run: it reuses the existing database and only replaces the secrets you choose to change.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WIN = process.platform === 'win32';

// ------------------------------------------------------------------ helpers
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
// Hidden input: the prompt stays visible and each typed character shows as "*".
// (Readline redraws "prompt + line" on some terminals, e.g. Windows, so mask only the typed part.)
let mutedPrompt = null;
rl._writeToOutput = function (s) {
  if (mutedPrompt === null) return rl.output.write(s);
  if (/[\r\n]/.test(s)) return rl.output.write('\r\n');
  if (s.startsWith(mutedPrompt)) return rl.output.write(mutedPrompt + '*'.repeat(rl.line.length));
  rl.output.write('*'.repeat([...s].length));
};
const ask = (q, def = '') => new Promise((res) => rl.question(`${q}${def ? c.d(` [${def}]`) : ''}: `, (a) => res(a.trim() || def)));
const askSecret = (q) => new Promise((res) => {
  const prompt = `${q}: `;
  mutedPrompt = prompt;             // set first, so the label itself is written unmasked
  rl.question(prompt, (a) => { mutedPrompt = null; res(a); });
});
const yes = async (q, def = 'y') => (await ask(`${q} (y/n)`, def)).toLowerCase().startsWith('y');
const step = (n, t) => console.log(`\n${c.b(`${n}. ${t}`)}`);
const fail = (m) => { console.error(c.r(`\n✖ ${m}`)); process.exit(1); };

function wrangler(args, { capture = false, input } = {}) {
  const r = spawnSync(WIN ? 'npx.cmd' : 'npx', ['wrangler', ...args], {
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    input, encoding: 'utf8', shell: WIN, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const hash = (pw) => {
  const salt = randomBytes(16);
  // 100,000 is the maximum PBKDF2 iteration count Cloudflare Workers accepts.
  return `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('base64')}`;
};
const validUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

// ------------------------------------------------------------------ main
console.log(c.b('\nFasta Status setup'));
console.log(c.d('Deploys the status page to your free Cloudflare account. Press Enter to accept a [default].'));

if (!existsSync(join(ROOT, 'node_modules', 'wrangler'))) {
  console.log('Installing dependencies…');
  const r = spawnSync(WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit', shell: WIN });
  if (r.status !== 0) fail('npm install failed.');
}

step(1, 'Cloudflare account');
let who = wrangler(['whoami'], { capture: true });
if (!/associated with the email|You are logged in/i.test(who.out) || /not authenticated/i.test(who.out)) {
  console.log('A browser window will open. Log in to Cloudflare (or create a free account) and click Allow.');
  if (!wrangler(['login']).ok) fail('Cloudflare login failed.');
  who = wrangler(['whoami'], { capture: true });
}
console.log(c.g('✔ Logged in to Cloudflare'));

// If this login can see several Cloudflare accounts, Wrangler cannot choose one on its own
// in non-interactive commands, so ask once and pin it for the rest of setup.
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  const accounts = [...who.out.matchAll(/[│|]\s*([^│|\n]+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]/g)].map((m) => ({ name: m[1], id: m[2] }));
  if (accounts.length > 1) {
    console.log('  This login has access to several Cloudflare accounts:');
    accounts.forEach((a, i) => console.log(`    ${i + 1}) ${a.name} (${a.id})`));
    console.log(c.d('  Pick the account that has fastadeliveries.co.ke.'));
    let pick;
    while (!pick) pick = accounts[Number(await ask('  Which account?', '1')) - 1];
    process.env.CLOUDFLARE_ACCOUNT_ID = pick.id;
    console.log(c.g(`  ✔ Using ${pick.name}`));
  } else if (accounts.length === 1) {
    process.env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  }
}

step(2, 'Which environment?');
const staging = (await ask('Production or staging? (p/s)', 'p')).toLowerCase().startsWith('s');
const NAME = staging ? 'fasta-status-staging' : 'fasta-status';
const CONFIG = staging ? 'wrangler.staging.toml' : 'wrangler.toml';
const prev = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
const prevVar = (k, d) => (prev.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || d);

step(3, 'Web address for the status page');
console.log(`  a) Your own domain, e.g. ${staging ? 'status-staging' : 'status'}.fastadeliveries.co.ke ${c.d('(fastadeliveries.co.ke DNS must be on this Cloudflare account)')}`);
console.log(`  b) A free Cloudflare address, e.g. ${NAME}.<your-name>.workers.dev ${c.d('(works immediately, no DNS needed)')}`);
const useDomain = (await ask('Choose a or b', prev.includes('custom_domain = true') ? 'a' : 'b')).toLowerCase().startsWith('a');
let HOST = '';
if (useDomain) {
  HOST = (await ask('Status page hostname', prev.match(/pattern = "([^"]+)"/)?.[1] || (staging ? 'status-staging.fastadeliveries.co.ke' : 'status.fastadeliveries.co.ke'))).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

step(4, 'What to monitor');
let STOREFRONT, API;
do { STOREFRONT = (await ask('Storefront URL (Next.js)', prevVar('STOREFRONT_URL', staging ? 'https://staging-web.fastadeliveries.co.ke' : 'https://web.fastadeliveries.co.ke'))).replace(/\/+$/, ''); } while (!validUrl(STOREFRONT) && console.log(c.r('  Enter a full URL starting with https://')) === undefined);
do { API = (await ask('Laravel backend URL', prevVar('API_URL', staging ? 'https://staging.fastadeliveries.co.ke' : 'https://fastadeliveries.co.ke'))).replace(/\/+$/, ''); } while (!validUrl(API) && console.log(c.r('  Enter a full URL starting with https://')) === undefined);
const SELLER = await ask('Seller login path', prevVar('SELLER_LOGIN_PATH', '/login/vendor'));
console.log(c.d('  The catalogue check fails while you have no zones/modules set up in the Fasta admin.'));
const CATALOGUE = (await yes('Check that the catalogue is not empty?', prevVar('CATALOGUE_CHECK', 'true') === 'false' ? 'n' : 'y')) ? 'true' : 'false';
const BRAND = await ask('Test BrandSite slug (blank = not yet)', prevVar('BRANDSITE_TEST_SLUG', ''));

step(5, 'Database');
let dbId = prev.match(/database_id = "([0-9a-f-]{36})"/)?.[1];
if (!dbId) {
  const created = wrangler(['d1', 'create', NAME], { capture: true });
  dbId = created.out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/)?.[1];
  if (!dbId) {
    const list = wrangler(['d1', 'list', '--json'], { capture: true });
    try { dbId = JSON.parse(list.out.slice(list.out.indexOf('['))).find((d) => d.name === NAME)?.uuid; } catch {}
  }
  if (!dbId) { console.log(created.out); fail('Could not create or find the D1 database.'); }
}
console.log(c.g(`✔ Database ${NAME} (${dbId})`));

// ------------------------------------------------------------------ write config
const toml = `# Generated by \`npm run setup\` on ${new Date().toISOString()}. Re-run setup to change it.
name = "${NAME}"
main = "src/index.ts"
compatibility_date = "2026-10-01"
${useDomain ? `workers_dev = false
preview_urls = false
routes = [
  { pattern = "${HOST}", custom_domain = true }
]` : `workers_dev = true
preview_urls = false`}

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "404-page"
run_worker_first = ["/api/*", "/admin/api/*"]

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "${NAME}"
database_id = "${dbId}"
migrations_dir = "migrations"

[observability]
enabled = true

[vars]
STOREFRONT_URL = "${STOREFRONT}"
API_URL = "${API}"
SELLER_LOGIN_PATH = "${SELLER}"
CATALOGUE_CHECK = "${CATALOGUE}"
CATALOGUE_ZONE_IDS = "${prevVar('CATALOGUE_ZONE_IDS', '[1]')}"
STOREFRONT_LISTING_PATH = "${prevVar('STOREFRONT_LISTING_PATH', '')}"
BRANDSITE_TEST_SLUG = "${BRAND}"
BRANDSITE_CUSTOM_DOMAIN_URL = "${prevVar('BRANDSITE_CUSTOM_DOMAIN_URL', '')}"
TRACKING_ENABLED = "${prevVar('TRACKING_ENABLED', 'false')}"
CHECKOUT_QUOTE_ENABLED = "${prevVar('CHECKOUT_QUOTE_ENABLED', 'false')}"
CHECK_TIMEOUT_MS = "10000"
SLOW_RESPONSE_MS = "5000"
FAIL_THRESHOLD = "3"
RECOVER_THRESHOLD = "2"
STALE_AFTER_SECONDS = "180"
PUBLIC_CACHE_SECONDS = "15"
ACCESS_TEAM_DOMAIN = "${prevVar('ACCESS_TEAM_DOMAIN', '')}"
ACCESS_AUD = "${prevVar('ACCESS_AUD', '')}"
PUBLIC_URL = "${useDomain ? `https://${HOST}` : prevVar('PUBLIC_URL', '')}"
DASHBOARD_URL = "${useDomain ? `https://${HOST}/admin/` : prevVar('DASHBOARD_URL', '')}"
`;
if (prev && prev !== toml) copyFileSync(CONFIG, `${CONFIG}.bak`);
writeFileSync(CONFIG, toml);
console.log(c.g(`✔ Wrote ${CONFIG}`));

step(6, 'Create database tables');
if (!wrangler(['d1', 'migrations', 'apply', NAME, '--remote', '-c', CONFIG], { input: 'y\n' }).ok) fail('Database migration failed.');
console.log(c.g('✔ Tables ready'));

step(7, 'Deploy');
const dep = wrangler(['deploy', '-c', CONFIG], { capture: true });
console.log(c.d(dep.out.split('\n').filter((l) => /Uploaded|Deployed|https:\/\/|schedule|error|Error/i.test(l)).join('\n')));
if (!dep.ok) {
  if (useDomain && /zone|custom domain|hostname/i.test(dep.out)) console.log(c.y('\nThe custom domain failed. Check that fastadeliveries.co.ke is an active zone on this Cloudflare account, or re-run setup and choose option b.'));
  fail('Deploy failed. See the output above.');
}
let PUBLIC = useDomain ? `https://${HOST}` : (dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? '');
console.log(c.g(`✔ Deployed${PUBLIC ? `: ${PUBLIC}` : ''}`));
if (!useDomain && PUBLIC && !prev.includes(PUBLIC)) {
  // Now that we know the workers.dev address, store it so alerts link to the right dashboard.
  writeFileSync(CONFIG, readFileSync(CONFIG, 'utf8')
    .replace(/^PUBLIC_URL = ".*"$/m, `PUBLIC_URL = "${PUBLIC}"`)
    .replace(/^DASHBOARD_URL = ".*"$/m, `DASHBOARD_URL = "${PUBLIC}/admin/"`));
  wrangler(['deploy', '-c', CONFIG], { capture: true });
}

// ------------------------------------------------------------------ secrets
const secrets = {};
step(8, 'Operator logins (for /admin)');
const hasUsers = /ADMIN_USERS/.test(wrangler(['secret', 'list', '-c', CONFIG], { capture: true }).out);
if (!hasUsers || await yes('Operator logins already exist. Replace them?', 'n')) {
  console.log(c.d('  Add each person who may post incidents. Passwords: at least 12 characters.'));
  const ops = {};
  while (true) {
    const email = (await ask(`  Operator email${Object.keys(ops).length ? ' (blank to finish)' : ''}`)).toLowerCase();
    if (!email) { if (Object.keys(ops).length) break; console.log(c.r('  Add at least one operator.')); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.log(c.r('  That is not an email address.')); continue; }
    const p1 = await askSecret('  Password (hidden)');
    if (p1.length < 12) { console.log(c.r('  Use at least 12 characters.')); continue; }
    const p2 = await askSecret('  Repeat password');
    if (p1 !== p2) { console.log(c.r('  Passwords did not match.')); continue; }
    ops[email] = hash(p1);
    console.log(c.g(`  ✔ ${email}`));
  }
  secrets.ADMIN_USERS = JSON.stringify(ops);
  secrets.SESSION_SECRET = randomBytes(32).toString('hex');
}

step(9, 'Private alerts');
console.log(c.d('  Telegram is free and reaches phones instantly. You can also use a Slack/Discord/Google Chat webhook.'));
if (await yes('Set up Telegram alerts?', 'y')) {
  console.log('  1) In Telegram, message @BotFather, send /newbot, and follow the steps.');
  const token = (await askSecret('  2) Paste the bot token (hidden)')).trim();
  if (token) {
    console.log('  3) Add the bot to your ops group (or open a chat with it) and send any message, e.g. "hello".');
    await ask('     Press Enter when done');
    let chats = [];
    try {
      const r = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
      const seen = new Map();
      for (const u of r.result ?? []) { const ch = (u.message ?? u.my_chat_member ?? u.channel_post)?.chat; if (ch) seen.set(ch.id, ch.title || ch.username || ch.first_name || String(ch.id)); }
      chats = [...seen.entries()];
    } catch {}
    let chatId = '';
    if (chats.length === 1) chatId = String(chats[0][0]);
    else if (chats.length > 1) {
      chats.forEach(([id, name], i) => console.log(`     ${i + 1}) ${name} (${id})`));
      chatId = String(chats[Number(await ask('     Which chat should get alerts?', '1')) - 1]?.[0] ?? '');
    }
    if (!chatId) chatId = await ask('     Could not detect the chat. Enter the chat id manually');
    if (chatId) {
      const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: '✅ Fasta Status alerts are connected. You will get a message here when a Fasta service fails or recovers.' }) }).then((r) => r.ok).catch(() => false);
      console.log(t ? c.g('  ✔ Test message sent to Telegram') : c.y('  ! Test message failed. Check the token and chat id.'));
      secrets.TELEGRAM_BOT_TOKEN = token;
      secrets.TELEGRAM_CHAT_ID = chatId;
    }
  }
}
if (await yes('Also send alerts to a Slack/Discord/Google Chat webhook?', 'n')) {
  const hook = (await askSecret('  Webhook URL (hidden)')).trim();
  if (validUrl(hook)) secrets.ALERT_WEBHOOK_URL = hook;
}

if (Object.keys(secrets).length) {
  const dir = mkdtempSync(join(tmpdir(), 'fasta-status-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  const r = wrangler(['secret', 'bulk', file, '-c', CONFIG], { capture: true });
  unlinkSync(file);
  if (!r.ok) { console.log(r.out); fail('Saving secrets failed.'); }
  console.log(c.g(`✔ Saved secrets: ${Object.keys(secrets).join(', ')}`));
}

rl.close();
console.log(`\n${c.g(c.b('All done.'))}`);
if (PUBLIC) {
  console.log(`  Public status page: ${c.b(PUBLIC)}`);
  console.log(`  Operator dashboard: ${c.b(`${PUBLIC}/admin/`)}`);
}
console.log(c.d('  The first checks run within a minute. Custom domains can take a few minutes to get their certificate.'));
console.log(c.d(`  Change settings later by re-running \`npm run setup\` or editing ${CONFIG} and running \`npx wrangler deploy -c ${CONFIG}\`.`));
console.log(`\n  Next: set ${c.b('FASTA_STATUS_URL')} (Laravel) and ${c.b('NEXT_PUBLIC_STATUS_URL')} (storefront) to ${PUBLIC || 'the status page URL'} so the footer links point here.\n`);
