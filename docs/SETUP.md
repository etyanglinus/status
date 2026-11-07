# Manual setup (advanced)

> **Most people should use [INSTALL.md](../INSTALL.md) instead.** `npm run setup` does steps 1–6 for
> you, with built-in email/password operator sign-in. This page covers the manual route, Cloudflare Access
> as an alternative login, staging, and free-plan limits.

Setup takes about 30 minutes and costs US$0.

You need: a free Cloudflare account, and the `fastadeliveries.co.ke` DNS zone on Cloudflare
(if DNS is elsewhere, see "DNS not on Cloudflare" at the bottom). Run from this folder.

## 1. Install and log in
```bash
npm install
npx wrangler login
```

## 2. Create your config and databases
Copy `wrangler.example.toml` to `wrangler.toml` (`npm run setup` does this for you).

```bash
npx wrangler d1 create fasta-status
npx wrangler d1 create fasta-status-staging
```
Paste each `database_id` into your `wrangler.toml` (production block and `[env.staging]`), then:
```bash
npx wrangler d1 migrations apply fasta-status --remote
npx wrangler d1 migrations apply fasta-status-staging --remote --env staging
```

## 3. Check the monitor targets in `wrangler.toml`
Production defaults were verified against the live sites on 7 Nov 2026 (see MONITORS.md).
Set the `[env.staging]` URLs to your **real staging** storefront and Laravel hosts. The values in
the file are placeholders.

## 4. Operator sign-in

**Option A, built-in (simplest):** `npm run setup` stores operator emails with PBKDF2-hashed passwords in the
`ADMIN_USERS` secret and a random `SESSION_SECRET`. Sessions last 12 hours (HttpOnly, Secure, SameSite=Strict
cookie), and an IP is locked out for 15 minutes after 8 wrong passwords.

**Option B, Cloudflare Access (adds email one-time codes and SSO; Zero Trust signup may ask for a card):**
1. Cloudflare dashboard → **Zero Trust** → pick a team name (e.g. `fasta`) → Free plan.
2. **Settings → Authentication**: keep **One-time PIN** (email code). No Fasta login involved.
3. **Access → Applications → Add → Self-hosted**:
   - Domain: `status.fastadeliveries.co.ke`, path `admin` (this covers `/admin/` and `/admin/api/`).
   - Policy: *Allow*, Include → Emails → the operators' addresses (use personal or Gmail
     addresses too, so the team can still sign in if Fasta's email is affected).
4. Copy the application's **Audience (AUD) tag** into `ACCESS_AUD`, and your team domain
   (`fasta.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN` in `wrangler.toml`.
   Repeat with a second application for `status-staging…` and `[env.staging]`.

The Worker verifies the Access token itself, so the admin API stays closed even if the Access
policy is misconfigured. Until `ACCESS_AUD` is set, nobody can sign in (fail-closed).

Optional break-glass token (for scripts, or if Access is unavailable), at least 32 characters:
```bash
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
```
Store it in your password manager. Use it as `Authorization: Bearer <token>` on `/admin/api/*`.

## 5. Private alerts
**Telegram (recommended, free):** message `@BotFather` → `/newbot` → copy the token. Add the bot
to your ops group, send a message in the group, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (negative for groups).
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```
**Or Slack / Discord / Google Chat:** create an incoming webhook, then
`npx wrangler secret put ALERT_WEBHOOK_URL`.

Repeat with `--env staging` for staging.

## 6. Deploy
```bash
npx wrangler deploy
npx wrangler deploy --env staging
```
`routes … custom_domain = true` creates the DNS record and certificate automatically.
`workers_dev = false` keeps the Worker off `*.workers.dev`, so the admin area only exists
behind Access.

Open `https://status.fastadeliveries.co.ke/admin/`, sign in, press **Run checks now**, then
check the public page.

## 7. Footer links in Fasta
Both repos read the status URL from the environment (patches in `../patches/`):
- Laravel: `FASTA_STATUS_URL=https://status.fastadeliveries.co.ke` (staging: the staging URL). Run
  `php artisan config:clear` after changing it. An empty value hides the link.
- Next.js: `NEXT_PUBLIC_STATUS_URL=…` at build time. `off` hides the link.

## Local development
```bash
cat > .dev.vars <<'VARS'
STOREFRONT_URL=http://127.0.0.1:8790
API_URL=http://localhost:8790
ALERT_WEBHOOK_URL=http://localhost:8790/hook
DEV_ADMIN_EMAIL=you@example.com
STALE_AFTER_SECONDS=30
PUBLIC_CACHE_SECONDS=0
VARS
npm run db:migrate:local
node scripts/fake-fasta.mjs &      # fake Fasta you can break on purpose
cp wrangler.example.toml wrangler.toml   # local only
npm run dev                        # http://127.0.0.1:8787 and /admin/
scripts/drill.sh                   # rehearse the acceptance tests
```
`DEV_ADMIN_EMAIL` only works for plain-HTTP loopback requests from `wrangler dev`. Never set it
as a production secret.

## Free-plan limits (comfortable)
| Limit | Free allowance | Fasta Status uses |
|---|---|---|
| Worker requests | 100,000/day | ~1,440 cron runs + page views (JSON is edge-cached 15 s) |
| Subrequests per run | 50 | ~16 (6 at a time) |
| D1 rows written | 100,000/day | ~29k with 18 checks |
| D1 rows read | 5M/day | ~1M; a page view reads 1 row |
| Access users | 50 | your ops team |

## DNS not on Cloudflare
Move the zone to Cloudflare (free, recommended), or put only the status page on a domain you
manage in Cloudflare and use a `routes = [{ pattern = "...", custom_domain = true }]` there.
