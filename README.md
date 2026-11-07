# Fasta Status

Public status page for Fasta Deliveries at **status.fastadeliveries.co.ke**: 11 services and 18 automated
checks every minute, per-check status with plain-language explanations, response times, uptime (24h/7d/30d/90d),
a log of detected problems, incidents, scheduled maintenance, a **Changelog** and **Upcoming features**.

Runs entirely on Cloudflare's **free plan**, separate from Fasta's Laravel/Next.js hosting, so it
stays up when Fasta is down.

| Piece | Cloudflare service (free) |
|---|---|
| Checks every 60 s | Worker + Cron Trigger |
| Results, incidents, changelog, roadmap | D1 (SQLite) |
| Public page + operator dashboard | Worker static assets |
| Operator sign-in (independent of Fasta login) | Built-in email + password (or Cloudflare Access, optional) |
| Private alerts | Telegram bot and/or Slack/Discord/Google Chat webhook |

```
public/            index.html (status, changelog, upcoming), incident.html, admin/ (operator dashboard)
src/               index.ts (routes + cron), config.ts (what is monitored), checks.ts, engine.ts (status rules),
                   store.ts (D1 + snapshot), present.ts (public JSON), admin.ts (operator API), auth.ts (Access JWT)
migrations/        D1 schema
scripts/           fake-fasta.mjs, drill.sh, tick.sh, show.sh (local outage drill)
docs/              SETUP.md, MONITORS.md, RUNBOOK.md, DRILL.md
```

- **Install (start here):** [INSTALL.md](INSTALL.md): `npm install` then `npm run setup`
- **Upgrade an existing install:** `npm install` then `npm run update` (keeps your `wrangler.toml`, data and logins)
- **Complete guide (fixes, admin, incidents, alerts, settings, troubleshooting):** [docs/GUIDE.md](docs/GUIDE.md)
- **Manual / advanced setup (Cloudflare Access, staging, limits):** [docs/SETUP.md](docs/SETUP.md)
- **Every check explained (live vs waiting on test data):** [docs/MONITORS.md](docs/MONITORS.md)
- **Incident runbook:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Drill results and staging drill procedure:** [docs/DRILL.md](docs/DRILL.md)

```bash
npm install
npm test           # 35 unit tests: thresholds, recovery, content checks, payments, images, stale data, auth, sessions
npm run typecheck
```
