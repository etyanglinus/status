# Outage drill

## Part A: local drill (done, 06 Nov 2026)
Run with `scripts/drill.sh` against `scripts/fake-fasta.mjs` (a stand-in for Laravel and the
storefront that can be broken on demand), on the real Worker code under `wrangler dev` with a
local D1 database. Settings: 3-failure alert, 2-success recovery, stale after 30 s (180 s in
production).

| # | Acceptance test (brief §7) | Result |
|---|---|---|
| 1 | Stop Laravel: API reports failure after threshold, team gets a private alert | ✅ After 1 failed run: still *Operational*. After 3: Fasta API and Seller dashboard *Major outage*. **One** alert per component, listing each failing check, reason, first-failure time (EAT) and dashboard link |
| 2 | Break storefront while Laravel is up | ✅ Storefront *Major outage* (maintenance redirect detected); API stayed *Operational* |
| 3 | HTTP 200 with unexpected content | ✅ `/up` without "Application up" and config JSON missing `business_name` both flagged; empty catalogue list flagged as `content.data is empty` |
| 4 | One failed request doesn't create a public outage | ✅ (also unit-tested) |
| 5 | Restore: automated recovery, operator verifies before closing | ✅ After 1 success checks stayed *down*; after 2 they recovered, but the public component stayed *Major outage* because the operator's incident was still open. Resolved by the operator (Monitoring → Resolved). Recovery alerts sent |
| 6 | Stop monitoring: page reports Status unavailable once stale | ✅ All monitored components *Status unavailable* with "Last confirmed: Operational at …"; normal after the next run |
| 7 | Publish and resolve an incident while Fasta's admin is unavailable | ✅ Incident created and resolved through the status admin API while the fake Laravel was down |
| 8 | No private URLs or secrets in public responses | ✅ `/api/status.json` contains no target hosts, reasons, webhook or operator emails. Admin auth covered by unit tests (valid / wrong-audience / expired / tampered Access JWT, spoofed Host, break-glass token) |
| 8b | Footer links and public page on mobile | ✅ Page checked at iPhone 13 size: no horizontal scroll, no console errors. Footer link code added to both repos (verify on staging after deploy) |

Raw output:
```

=== 1. Stop the Laravel backend (API + seller login unreachable)
-- after 1 failed run (must NOT be an outage):
OVERALL: All monitored systems operational | stale: False
  storefront  operational     
  api         operational     
  seller      operational     
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []
-- after 3 failed runs:
OVERALL: Service disruption | stale: False
  storefront  operational     
  api         major_outage    
  seller      major_outage    
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []
-- private alerts received:
  ---
  🔴 OUTAGE — Fasta API
  Check: Laravel /up health route
  Reason: Connection failed: Network connection lost.
  Check: GET /api/v1/config structure
  Reason: Connection failed: Network connection lost.
  Check: GET /api/v1/module returns catalogue modules
  Reason: Connection failed: Network connection lost.
  First failure: 6 Nov 2026, 4:42 p.m. EAT
  Checked from: Cloudflare ORD
  Dashboard: https://status.fastadeliveries.co.ke/admin/
  Nothing is published publicly until an operator opens an incident (component status updates automatically).
  ---
  🔴 OUTAGE — Seller dashboard
  Check: Seller login page (/login/vendor)
  Reason: Connection failed: Network connection lost.
  First failure: 6 Nov 2026, 4:42 p.m. EAT
  Checked from: Cloudflare ORD
  Dashboard: https://status.fastadeliveries.co.ke/admin/
  Nothing is published publicly until an operator opens an incident (component status updates automatically).

=== 2. Open a public incident while the 'Fasta admin panel' is down (status admin is independent)
incident id 1
OVERALL: Service disruption | stale: False
  storefront  operational     
  api         major_outage    
  seller      major_outage    
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: ['Fasta app and seller dashboard unavailable']

=== 3. Restore the backend: one success is not enough, two are
-- after 1 success:
   storefront.home up
   api.up down
   api.config down
   api.catalogue down
   seller.login down
-- after 2 successes: checks recovered automatically...
   storefront.home up
   api.up up
   api.config up
   api.catalogue up
   seller.login up
-- ...but the public page keeps the operator's incident open until they verify and resolve:
OVERALL: Service disruption | stale: False
  storefront  operational     
  api         major_outage    
  seller      major_outage    
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: ['Fasta app and seller dashboard unavailable']
-- after operator resolves:
OVERALL: All monitored systems operational | stale: False
  storefront  operational     
  api         operational     
  seller      operational     
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []

=== 4. Break the storefront while Laravel stays up
OVERALL: Service disruption | stale: False
  storefront  major_outage    
  api         operational     
  seller      operational     
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []

=== 5. HTTP 200 with unexpected content on /up, and an empty catalogue list
OVERALL: Some services are degraded | stale: False
  storefront  operational     
  api         partial_outage  
  seller      operational     
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []
   api.up -> Expected content missing: "Application up"
   api.config -> JSON field "content.business_name" is missing
   api.catalogue -> OK
   api.up -> OK
   api.config -> OK
   api.catalogue -> JSON field "content.data" is empty

=== 6. Stop monitoring (no cron runs) until results are stale
(waiting 35s, STALE_AFTER_SECONDS=30 locally)
OVERALL: Status unavailable | stale: True
  storefront  unavailable     last confirmed: operational
  api         unavailable     last confirmed: operational
  seller      unavailable     last confirmed: operational
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []
-- monitoring resumes:
OVERALL: All monitored systems operational | stale: False
  storefront  operational     
  api         operational     
  seller      operational     
  brandsite   unmonitored     
  checkout    unmonitored     
  tracking    unmonitored     
  active incidents: []

=== 7. Leak check: public JSON must not contain URLs of targets, reasons or secrets
  (no LEAK lines above = pass)

=== 8. Recovery alerts sent
  > 🔴 OUTAGE — Fasta API
  > 🔴 OUTAGE — Seller dashboard
  > ✅ RECOVERED — Fasta API
  > ✅ RECOVERED — Seller dashboard
  > 🔴 OUTAGE — Customer storefront
  > ✅ RECOVERED — Customer storefront
  > 🔴 OUTAGE — Fasta API
  > ✅ RECOVERED — Fasta API
  > 🔴 OUTAGE — Fasta API
  > ✅ RECOVERED — Fasta API
```

## Part B: staging drill (to run after deploying `--env staging`)
Not done yet: it needs your staging servers and Cloudflare account.

1. Confirm `[env.staging]` targets are the staging hosts, deploy, and wait for green.
2. **Stop the staging Laravel backend** (e.g. `php artisan down` or stop php-fpm). Note the time.
   - Expect: within ~3 min, Fasta API and Seller dashboard show an outage on
     status-staging, and Telegram/webhook gets one alert per component.
   - Confirm status-staging still loads (it doesn't use Fasta's servers).
3. While it's down, open an incident from status-staging/admin (Investigating, next update in 30 min).
4. **Break the staging storefront only** (stop the Next.js process or enable maintenance mode).
   Expect: storefront outage; API keeps its own status.
5. Restore both. Expect: recovery after 2 good runs plus a recovery alert. The incident stays open.
   Verify the flows by hand, then post Monitoring → Resolved.
6. Stale test: `npx wrangler triggers deploy --env staging` with an empty `crons = []` (or
   comment out the cron and deploy), wait 3+ min, and expect *Status unavailable* with "Last
   confirmed". Restore the cron.
7. On a phone: Laravel and storefront footers show **System status** and open status-staging.
8. `curl https://status-staging…/api/status.json | grep -i -E 'staging\.|http|token|@'`
   should return no target URLs or emails. `curl https://status-staging…/admin/api/overview` without
   signing in should return **401**.
9. Delete the drill incident in admin and record timings and any surprises here.

Before production: confirm the hostname, that the Cloudflare zone is ready, the alert
destination, and the operator email list for Access.
