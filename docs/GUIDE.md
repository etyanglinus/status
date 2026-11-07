# Fasta Status: complete guide

Contents
1. [Upgrade your live status page to this version](#1-upgrade-your-live-status-page-to-this-version)
2. [Fix the problems it shows today](#2-fix-the-problems-it-shows-today)
3. [Reading the public page](#3-reading-the-public-page)
4. [The admin dashboard, screen by screen](#4-the-admin-dashboard-screen-by-screen)
5. [Handling an incident, start to finish](#5-handling-an-incident-start-to-finish)
6. [Alerts on Telegram](#6-alerts-on-telegram)
7. [Changing settings](#7-changing-settings)
8. [Managing operators (who can sign in)](#8-managing-operators-who-can-sign-in)
9. [Turning on the "coming soon" checks](#9-turning-on-the-coming-soon-checks)
10. [Troubleshooting](#10-troubleshooting)
11. [Free-plan usage](#11-free-plan-usage)

Where "terminal" is mentioned: on Windows open the `fasta-status` folder in File Explorer, click the address bar,
type `powershell` and press Enter. On a Mac, open Terminal and `cd` into the folder.

---

## 1. Upgrade your live status page to this version

You already ran `npm run setup`, so your folder contains **your own `wrangler.toml`** (it holds your database ID).
The new zip deliberately does **not** include a `wrangler.toml`, so unzipping over your folder keeps yours.

**Step 1: Back up your settings file.** Copy `wrangler.toml` from your `fasta-status` folder to your Desktop.
*Why:* if anything goes wrong, you can put it back.

**Step 2: Unzip the new version over your folder.** Extract `fasta-status.zip`, then copy everything inside
its `fasta-status` folder into your existing `fasta-status` folder. Choose **Replace** when asked.
*You should see:* your folder still has `wrangler.toml`, plus a new `wrangler.example.toml`.

**Step 3: Run the update.** In the terminal, inside the folder:
```bash
npm install
```
```bash
npm run update
```
*You should see, in order:*
- `✔ Updated wrangler.toml: slow-response limit 4 s → 5 s, added CATALOGUE_ZONE_IDS`
- `1. Upgrading the database`, then a table listing `0003_detail.sql` with ✅. If asked "Ok to proceed?", type `y`.
- `2. Deploying the new version`, then `Deployed fasta-status triggers` and your domain.
- `✔ Updated. Open https://status.fastadeliveries.co.ke`

**Step 4: Check it.** Wait 2 minutes, then open https://status.fastadeliveries.co.ke.
*You should see:* a summary line ("… of 11 services fully operational · 18 automated checks every minute"),
services grouped under **Customers / Sellers / Delivery partners / Platform**, and a "Details" link on each service.

Your history, incidents, changelog, roadmap, operator logins and Telegram settings are all kept.
Uptime bars from before the upgrade still show; response-time charts start from now.

---

## 2. Fix the problems it shows today

These are real problems on fastadeliveries.co.ke (checked 7 Nov 2026), not monitor errors.

### 2a. Catalogue: "Partial outage: Store types are available: Returning no data"
**Cause:** no modules (store types such as Food, Grocery, Pharmacy) and no zones exist in the Fasta admin.
Customers can't browse or order anything.

**Fix, in the Fasta admin panel** (`fastadeliveries.co.ke` admin login):
1. **Zone setup → Zone** (sometimes **Business Zone**) → **Add new zone**. Draw the area you deliver to
   (e.g. Nairobi), save, and make sure its status is **Active**.
2. **System Module Setup → Modules** (or **Business Module**) → **Add new module**. Pick a type
   (e.g. *Food* or *Grocery*), give it a name, and save. Then open the zone you created and enable the module in it.
3. Add at least one store and product in that module.
4. Check it: open https://fastadeliveries.co.ke/api/v1/module in a browser. You should see `"total":1` (or more)
   instead of `"total":0`.

Within 2–3 minutes the Catalogue service turns **Operational**.

**If you're not ready to set up the catalogue yet,** switch these checks off so they don't show as an outage:
1. Open `wrangler.toml` in Notepad (Windows) or TextEdit (Mac).
2. Find `CATALOGUE_CHECK = "true"` and change it to `CATALOGUE_CHECK = "false"`. Save.
3. In the terminal: `npm run update`.
*You should see:* Catalogue shows "No known issues · Updated by the Fasta team". Switch it back to `"true"` later.

### 2b. Customer website / Seller dashboard: "Degraded performance: Responding slowly"
**Cause:** pages took longer than 5 seconds to load several times in a row. From our tests, the storefront
homepage takes **2–5 seconds** to start loading. That's slow for customers too, especially on mobile data.

**Check the numbers:** status page → **Customer website → Details**. The **Response now** and **24h average**
boxes and the hourly bar chart show exactly how slow it is and when.

**Ways to speed it up** (each helps; start with the first):
1. **Cloudflare caching for images and scripts:** Cloudflare dashboard → `fastadeliveries.co.ke` →
   **Caching → Configuration** → Browser cache TTL = *Respect existing headers*. **Speed → Optimization** →
   turn on *Brotli* and *Early Hints*.
2. **Laravel caches** on the server, after each deploy:
   ```bash
   php artisan config:cache && php artisan route:cache && php artisan view:cache
   ```
3. **PHP OPcache** must be on (cPanel → *Select PHP Version* → Extensions → `opcache` ✓).
4. **Next.js homepage:** the storefront renders the homepage on every visit by calling the API. Caching the
   landing-page API responses for a few minutes (or making the homepage static with periodic refresh) removes most
   of the wait. This is a code change in the `web` repo.
5. **Hosting:** shared cPanel servers are often slow at busy times. A small VPS (2 vCPU / 4 GB) usually brings
   page loads under 1 second.

**If you only want to make the monitor less strict** (not recommended long-term): in `wrangler.toml` set
`SLOW_RESPONSE_MS = "8000"` and run `npm run update`.

### 2c. Uptime bars show very low uptime for 6–7 Nov
That's real: the storefront showed the maintenance page to everyone until 7 Nov. To start the history
fresh from today (optional, cannot be undone):
```bash
npx wrangler d1 execute fasta-status --remote --command "DELETE FROM daily; DELETE FROM hourly; DELETE FROM outages; DELETE FROM check_events;"
```
*You should see:* `🚣 4 commands executed successfully`. Bars show "No data" until new checks arrive.

---

## 3. Reading the public page

From top to bottom:

| Part | What it shows |
|---|---|
| **Banner** | One-line overall state: *All monitored systems operational*, *Some services are degraded*, *Service disruption*, *Scheduled maintenance in progress*, or *Status unavailable*, plus when checks last ran |
| **Summary line** | How many services are fully working, how many are affected, how many checks run, and how many are coming |
| **Active incidents** | Only appears when the team has opened one: title, impact, affected services, latest update, and **"Next update by"** |
| **Maintenance in progress** | Only during a planned window |
| **Services** | 11 services in 4 groups. Each shows status, a one-line summary (e.g. "1 of 2 checks slow: responding slowly"), and **90 daily bars** |
| **Details** (click on a service) | Uptime 24h / 7 / 30 / 90 days · response now · 24h average · **hourly response chart** (green bar = average response that hour; pink background = hour with failures; hover a bar for numbers) · **every check** with its status icon, what it proves, problem in plain words and since when, response time, 24h uptime, and when it last ran |
| **Problems detected by automated checks** | Every problem period in the last 30 days, even short ones that never needed an incident: service, what happened, start, end, duration |
| **Scheduled maintenance** | Upcoming planned work |
| **Past incidents** | Resolved incidents with their full timeline (click one for its own page) |
| **How we monitor Fasta** | Plain explanation of the rules and every status |

**Daily bar colours:** dark green 100% · light green 99–99.9% · amber 95–99% · orange 90–95% · red below 90% ·
grey = no data. A blue underline means an incident was reported that day. Hover (or tap) a bar for that day's
availability, minutes failing or slow, and average response time.

The page refreshes itself every minute, and keeps open "Details" panels open across refreshes.
If the status service can't be reached, it shows the last results it saw and says so.

---

## 4. The admin dashboard, screen by screen

Open https://status.fastadeliveries.co.ke/admin/ and sign in with the operator email and password from setup.
Sessions last 12 hours. 8 wrong passwords from one network blocks sign-in from it for 15 minutes.

### Monitors (opens first)
- **Top box:** when checks last ran, how many are live, how many are failing, how many are waiting on test data,
  and the current rules. **Run checks now** runs all checks immediately; use it after fixing something.
  Tick **Show only checks that are not passing** to filter.
- **Live checks table**, one row per check:
  | Column | Meaning |
  |---|---|
  | Check | Service, internal name, the label customers see, and whether it's an availability or content check |
  | State | `up`, `degraded` or `down` after the 3-in-a-row rule; the very last raw result; how long ago |
  | Last result (private) | The **exact technical reason** (e.g. `HTTP 502`, `JSON field "content.data" is empty`), status code, response time, first failure and "down since" times |
  | Response, 24h | Mini chart: one bar per hour (height = average response, red = failures; hover for numbers), average and slowest |
  | Uptime | 24 hours, 7 days and 30 days |
  | Streaks | Consecutive failures / successes, the counters behind the 3-in-a-row and 2-in-a-row rules |
  | Target | Method, URL (test-order details hidden), expected code, and the slow limit |
- **Detected problem periods:** start, end, length, service, check, type. The same events the public sees, with check IDs.
- **Waiting on test setup:** what each "coming soon" check needs (see section 9).
- **Alert log:** every outage and recovery, the private reason, and whether the alert was **delivered**.
  "no channel / failed" means Telegram or the webhook isn't set up correctly (see section 6).

### Incidents
Left: **Open an incident**. Right: open incidents (each with an update form) and resolved ones.
See section 5 for the full walkthrough. "Delete" is only for test incidents; real ones stay as public history.

### Maintenance
Add a title, start and end time (East Africa Time), affected services, and expected customer impact.
During the window those services show **Scheduled maintenance** instead of an outage. Use **Cancel window**
if plans change, and **Edit** to move it. Publish planned downtime at least **48 hours** ahead.

### Changelog
Release notes for customers, sellers and riders. Type: New / Improved / Fixed. Audience: Everyone / Customers /
Sellers / Delivery partners. A future date schedules the entry; "Save as draft" hides it.

### Upcoming
The public roadmap. Stage: Planned → In progress → In beta → Shipped. Use loose timing ("Early 2027").
"Order" sets the position (lower = first). "Hide" removes it from the public page without deleting it.

---

## 5. Handling an incident, start to finish

**Example:** customers report they can't pay, and Telegram shows "🔴 OUTAGE: Checkout and payments".

**1. Confirm (2 minutes).** Open `/admin/` → **Monitors** and read *Last result (private)* for the checkout
checks. Try a payment yourself on the website.

**2. Open the incident (within 10 minutes).** **Incidents → Open an incident:**
- Title: `Some customers can't complete payment`
- Impact: **Partial outage** (some people/flows fail). Use **Major outage** if nobody can pay.
- Next update by: 30 minutes from now
- Affected components: tick **Checkout and payments**
- Click **Use template**, then replace the [brackets]:
  > Some customers are unable to complete payment. Browsing, cash on delivery and order tracking are working. We're investigating and will post another update by 3:30 p.m. EAT.
- **Publish incident.** *You should see:* the incident at the top of the public page, with "Next update by 3:30 p.m. EAT".

**3. Update as you learn more.** On the open incident: Stage **Identified**, set the next update time, click the
**Identified** template, and write what's wrong in plain words and what you're doing:
> We've found the cause: our card payment provider is rejecting requests. We're switching to the backup provider. Next update by 4:00 p.m. EAT.

**4. Fix in place:** Stage **Monitoring**:
> A fix is in place and payments are going through again. We're monitoring to make sure it stays stable.

**5. Verify, then resolve.** Automated checks recovering is **not** enough. Make a real test payment first.
Then Stage **Resolved**:
> This is resolved. Between 2:55 and 3:40 p.m. EAT some customers could not pay by card. If you were charged but didn't get an order confirmation, the charge will be reversed within 48 hours. No other action is needed.

**Rules:** post before every "next update" time passes (overdue updates are flagged publicly) · every 30 min for
major outages, 60 min otherwise · never post internal URLs, server names, error codes, or customer details.

---

## 6. Alerts on Telegram

**When you get one:** a service starts failing (3 failures in a row), becomes slow (3 slow results in a row),
or recovers (2 successes in a row). Everything that changed in the same minute arrives as **one message**,
so a full backend outage is one notification, not eleven.

**What it contains:**
```
⚠️ Fasta Status: 2 services with problems

🔴 OUTAGE — Fasta API
Check: Laravel /up health route
Reason: HTTP 502 (expected 200)
First failure: 7 Nov 2026, 2:55 p.m. EAT
Checked from: Cloudflare NBO
Dashboard: https://status.fastadeliveries.co.ke/admin/
```
**What to do:** open the dashboard link and follow section 5. An alert never publishes anything by itself:
the service's status changes on the public page automatically, but incidents are always written by a person.

**Not receiving alerts?** Check the **Alert log** in Monitors. "no channel / failed" means:
- the bot was removed from the group, or nobody ever sent it a message → add it back and send "hello";
- the token was revoked in @BotFather → re-run `npm run setup` and redo the Telegram step.

**Add more people:** add them to the Telegram group the bot posts in.

---

## 7. Changing settings

All settings are in `wrangler.toml`. Edit with Notepad or TextEdit, save, then run `npm run update`.

| Setting | Default | What it does |
|---|---|---|
| `STOREFRONT_URL` | `https://web.fastadeliveries.co.ke` | The customer website checked |
| `API_URL` | `https://fastadeliveries.co.ke` | The Laravel backend checked |
| `SELLER_LOGIN_PATH` | `/login/vendor` | Seller login page; change it if you change "Store login URL" in Fasta admin |
| `CATALOGUE_CHECK` | `true` | `false` turns off both catalogue checks |
| `CATALOGUE_ZONE_IDS` | `[1]` | Zone(s) used for the categories check, e.g. `[1,2]` |
| `CHECK_TIMEOUT_MS` | `10000` | How long to wait before "Not responding" (10 s) |
| `SLOW_RESPONSE_MS` | `5000` | Slower than this = "slow" (5 s) |
| `FAIL_THRESHOLD` | `3` | Bad results in a row before outage/slow is declared and alerted |
| `RECOVER_THRESHOLD` | `2` | Good results in a row before recovery |
| `STALE_AFTER_SECONDS` | `180` | No new results for this long = "Status unavailable" |
| `PUBLIC_CACHE_SECONDS` | `15` | How long Cloudflare caches the public data (absorbs traffic spikes) |
| `STOREFRONT_LISTING_PATH`, `BRANDSITE_TEST_SLUG`, `BRANDSITE_CUSTOM_DOMAIN_URL`, `TRACKING_ENABLED`, `CHECKOUT_QUOTE_ENABLED` | empty / false | Turn on "coming soon" checks (section 9) |

Secrets (never in `wrangler.toml`): set with `npx wrangler secret put NAME`, list with `npx wrangler secret list`.
`ADMIN_USERS`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL`, `ADMIN_TOKEN`,
`TRACKING_ORDER_ID`, `TRACKING_CONTACT`, `CHECKOUT_QUOTE_*`.

**Link from Fasta:** Laravel `.env` → `FASTA_STATUS_URL=https://status.fastadeliveries.co.ke` then
`php artisan config:clear`. Storefront `.env.production` → `NEXT_PUBLIC_STATUS_URL=https://status.fastadeliveries.co.ke`
then rebuild. In the Flutter apps, add a "System status" item that opens the same address.

---

## 8. Managing operators (who can sign in)

Operators are stored together; to add, remove or change a password, you re-enter the full list:
1. Terminal: `npm run setup`. Press Enter through the questions (your answers are remembered).
2. At **Operator logins already exist. Replace them?** type `y`.
3. Enter **every** person who should have access (email, password twice). Blank email to finish.
4. Finish the remaining steps (press Enter to skip Telegram if it already works: answer `n`).
*Result:* removed people are signed out immediately; everyone else signs in again.

---

## 9. Turning on the "coming soon" checks

| Check | Steps |
|---|---|
| **A test store page loads** | 1) Fasta admin: create a store "Fasta Status Test Store" in your main zone, always open, with one product. 2) Open it on web.fastadeliveries.co.ke and copy the path (e.g. `/store/fasta-status-test-store`). 3) `wrangler.toml`: `STOREFRONT_LISTING_PATH = "/store/fasta-status-test-store"`. 4) `npm run update`. |
| **A test order can be tracked** | 1) Place one cash-on-delivery order at the test store with a dedicated phone number. 2) Leave it unfulfilled forever; note the order ID. 3) `npx wrangler secret put TRACKING_ORDER_ID` (paste the ID), `npx wrangler secret put TRACKING_CONTACT` (the phone, e.g. `254700000000`). 4) `wrangler.toml`: `TRACKING_ENABLED = "true"`. 5) `npm run update`. |
| **A published test BrandSite loads** | 1) Log in as the test store's seller, create and publish a BrandSite. 2) Note its slug. 3) `BRANDSITE_TEST_SLUG = "<slug>"`. 4) `npm run update`. |
| **A test custom domain works** | 1) Connect a spare domain to the test BrandSite (BrandSite → Domain). 2) `BRANDSITE_CUSTOM_DOMAIN_URL = "https://that-domain"`. 3) `npm run update`. |
| **A test cart gets a delivery quote** | Needs a sandbox payment setup and an isolated test store; ask your developer. Never point it at live payments. |

---

## 10. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Everything "Status unavailable" | Checks haven't run for 3+ minutes | Cloudflare dashboard → Workers & Pages → `fasta-status` → **Logs**: look for errors. Run `npm run update` to redeploy. |
| One service "Major outage" | All its checks failing | `/admin` → Monitors → *Last result (private)* tells you exactly why |
| "Showing a maintenance page" | Fasta maintenance mode is on, or the storefront redirects to `/maintainance` | Fasta admin → Business Settings → Maintenance Mode **off for all systems**, then `php artisan optimize:clear` |
| "Not responding (timed out)" / "Could not be reached" | Server down, overloaded, or blocking Cloudflare | Check the server; in cPanel make sure Imunify360/ModSecurity isn't blocking Cloudflare IPs |
| "Returning server errors" | HTTP 5xx from Laravel | Server error log, `storage/logs/laravel.log` on the server |
| "Returning no data" | Empty list (e.g. no modules) | See section 2a |
| Check fails right after changing seller login URL | `SELLER_LOGIN_PATH` is out of date | Update it in `wrangler.toml`, then `npm run update` |
| `npm run update` says "wrangler.toml not found" | New folder without your settings | Copy your old `wrangler.toml` in, or run `npm run setup` |
| `npm run update` asks to choose an account | Your Cloudflare login has several accounts | Pick the one with `fastadeliveries.co.ke` |
| Can't sign in to `/admin` | Wrong password, or too many attempts | Wait 15 minutes; reset with section 8 |
| No Telegram alerts | See section 6 | |
| You see a 403 on a Fasta site | Your IP is blocked by a Cloudflare rule or the hosting firewall | Cloudflare → Security → **Events**: if listed, adjust the rule; if not, ask the host to unblock your IP |

---

## 11. Free-plan usage

| Cloudflare free allowance | Fasta Status uses |
|---|---|
| 100,000 Worker requests/day | ~1,440 scheduled runs + page views (public data cached 15 s) |
| 50 outgoing requests per run, 6 at a time | ~16 per run, run 6 at a time |
| D1: 100,000 rows written/day | ~29,000 (one row per check per minute + 2 summary rows) |
| D1: 5 million rows read/day | ~1 million (90-day history re-read every 10 minutes; a page view reads 1 row) |
| D1: 5 GB storage | well under 50 MB (hourly data kept 8 days, daily data 120 days) |

You can see actual usage in the Cloudflare dashboard → Workers & Pages → `fasta-status` → Metrics, and
Storage & Databases → D1 → `fasta-status` → Metrics.
