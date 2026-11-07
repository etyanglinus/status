# Install Fasta Status (start here)

Fasta Status is ready to use. You "upload" it by running one command on your computer that sends it to
your **free Cloudflare account**. It then runs there 24/7, separate from Fasta's own servers. Cost: **US$0**.

Total time: about **15 minutes**.

---

## What you need

1. **A computer** (Windows, Mac or Linux) with internet access.
2. **Node.js 20 or newer.** Download the "LTS" version from https://nodejs.org and install it with the
   default options. To check, open a terminal and run `node -v`. It should print `v20…` or higher.
   - Windows: open **PowerShell** (Start menu → type "PowerShell").
   - Mac: open **Terminal** (Spotlight → "Terminal").
3. **A free Cloudflare account:** https://dash.cloudflare.com/sign-up (no card needed).
4. **Telegram** on your phone, for alerts (optional but recommended).

To use `status.fastadeliveries.co.ke`, the `fastadeliveries.co.ke` domain must be added to that
Cloudflare account (Cloudflare dashboard → **Add a domain**, then change the nameservers at your
domain registrar). If it isn't, choose the free `*.workers.dev` address during setup and switch later.

---

## Step 1: Unzip the project
Unzip `fasta-status.zip` somewhere easy, for example `Documents\fasta-status`.

## Step 2: Open a terminal in that folder
- **Windows:** open the `fasta-status` folder in File Explorer, click the address bar, type
  `powershell`, and press Enter.
- **Mac:** open Terminal, type `cd ` (with a space), drag the `fasta-status` folder into the window, and press Enter.

## Step 3: Run the setup
```bash
npm install
```
```bash
npm run setup
```
The setup asks a few questions. Press **Enter** to accept the suggested answer in [brackets].

| Question | What to answer |
|---|---|
| Cloudflare login | A browser opens. Log in and click **Allow** |
| Production or staging | `p` (production) |
| Web address | `a` for `status.fastadeliveries.co.ke` (domain on Cloudflare), or `b` for a free `workers.dev` address |
| Storefront URL / Laravel URL / seller login path | Press Enter (already set to your live sites) |
| Check that the catalogue is not empty? | `n` until you have created zones and modules in the Fasta admin, then re-run setup and answer `y` |
| Operator email + password | Add each team member who may post incidents (password at least 12 characters). This is **not** your Fasta admin login |
| Telegram alerts | Follow the prompts: message **@BotFather** → `/newbot` → paste the token → send "hello" to the bot (or add it to your ops group and send a message there) → press Enter. A test message arrives |

At the end it prints your two links:
- **Public status page:** share this with customers and link it from Fasta.
- **Operator dashboard:** the same link with `/admin/`, where your team signs in.

The first checks run within a minute.

## Step 4: Connect it to Fasta (footer link)
Point the "System status" footer links at your status page:
- **Laravel** (`fastadeliveries.co.ke`): add this to the server's `.env`, then run `php artisan config:clear`:
  ```
  FASTA_STATUS_URL=https://status.fastadeliveries.co.ke
  ```
- **Storefront** (Next.js): add this to `.env.production` before building:
  ```
  NEXT_PUBLIC_STATUS_URL=https://status.fastadeliveries.co.ke
  ```
Use the `workers.dev` link instead if that's what you chose. The footer code is in
`patches/` (apply with `git am <file>.patch` in each repo).

In the Flutter apps, add a "System status" item in Help/Settings that opens the same link.

---

## Everyday use
Full walkthroughs for everything below: **[docs/GUIDE.md](docs/GUIDE.md)**.

- **Something breaks:** you get a Telegram alert. Open `/admin/` → **Incidents** → *Open an incident*,
  pick the affected services, and write what customers see. Post updates until it's resolved. See `docs/RUNBOOK.md`.
- **Planned work:** `/admin/` → **Maintenance**. Add a start/end time and the customer impact.
- **Release notes:** `/admin/` → **Changelog**.
- **Roadmap:** `/admin/` → **Upcoming**.

## Changing settings later
Run `npm run setup` again. It keeps your database and lets you change URLs, add or replace operators,
and update alerts. Or edit `wrangler.toml` and run `npm run update` (every setting is explained in [docs/GUIDE.md](docs/GUIDE.md#7-changing-settings)).

## Updating to a new version
Unzip the new version over your folder (choose **Replace**). The zip never contains `wrangler.toml`, so your
settings are kept. Then run:
```bash
npm install
```
```bash
npm run update
```
This upgrades the database, refreshes recommended settings and redeploys. Step by step, with what you should see
at each point: [docs/GUIDE.md](docs/GUIDE.md#1-upgrade-your-live-status-page-to-this-version).

## Troubleshooting
| Problem | Fix |
|---|---|
| `npm` or `node` not found | Install Node.js LTS from nodejs.org, then close and reopen the terminal |
| PowerShell says "running scripts is disabled" | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`, and try again |
| Custom domain fails during deploy | The domain must be an active zone on the same Cloudflare account. Or re-run setup and choose `b` |
| Page says "Status unavailable" right after deploy | Wait 1–2 minutes for the first checks |
| Storefront shows **Major outage** | The storefront is redirecting to its maintenance page. Turn maintenance mode off in Fasta admin (see below) |
| Fasta API shows **Partial outage** | The catalogue is empty. Add zones/modules, or re-run setup and answer `n` to the catalogue question |
| No Telegram alerts | Re-run setup and redo the Telegram step. The bot must be in the chat, and someone must have sent it a message |
| Forgot an operator password | Re-run `npm run setup`, answer `y` to "Replace them?", and enter all operators again |

### Fasta still shows maintenance after you turned it off
On 6 Nov 2026 the live API still reported `maintenance_mode: true` and the storefront still redirected to
`/maintainance`. In the Fasta admin, open **Business Settings → Maintenance Mode** and make sure it's off
for **all** systems (admin, vendor panel, customer web/app). Then clear the cache: **Settings → Clear cache**,
or on the server run:
```bash
php artisan optimize:clear
```
After that, `https://fastadeliveries.co.ke/api/v1/config` should show `"maintenance_mode":false`.
