# Incident runbook

**Status admin:** https://status.fastadeliveries.co.ke/admin/ (Cloudflare Access email code).
It does not depend on Fasta's servers, database or admin login.

## When an alert arrives
1. Open **/admin/ → Monitors**. Read the private reason (timeout, HTTP 5xx, maintenance redirect,
   missing content, empty JSON) and when the first failure happened.
2. Confirm by hand: open the storefront, seller login or app as a customer would.
3. If customers are affected, **publish an incident within 10 minutes**, even if you only know
   the symptom. The component already shows the measured outage, and the incident adds the
   human explanation and the next-update time.

## Stages
| Stage | When | Publish |
|---|---|---|
| **Investigating** | Impact confirmed, cause unknown | What users experience, what still works, next update time |
| **Identified** | Cause confirmed | The issue in plain language and what the team is doing |
| **Monitoring** | Fix deployed | The fix is in place and the team is checking the affected flow |
| **Resolved** | Customer flow verified | Restored, the impact window, any customer action |

Example (Investigating):
> Some customers are unable to complete checkout. Browsing and existing order tracking are available. We're investigating and will post another update by 3:30 p.m. EAT.

## Rules
- **Always set "Next update by"**, and post again before it passes, even just "Still
  investigating, next update by …". Overdue updates are flagged on the public page.
- Updates every **30 min** for major outages, **60 min** for partial or degraded.
- Pick **impact** honestly: *Major outage* = the service doesn't work for most people;
  *Partial outage* = some people or some flows fail; *Degraded* = slow or intermittent.
- Plain customer language. **Never post** internal URLs, server names, stack traces, error IDs,
  credentials, customer names, phone numbers or order details.
- **Automated recovery does not resolve the incident.** After checks go green, move to
  *Monitoring*, then verify the flow yourself (place a sandbox order, track the test order,
  sign in as the test seller) before *Resolved*.
- For payments, tell customers whether they were charged and what to do (e.g. "If you were
  charged and did not get an order confirmation, the payment will be reversed within 48 hours").
- The resolved message states the impact window in EAT: "Between 2:55 and 3:40 p.m. EAT…".

## Scheduled maintenance
**/admin/ → Maintenance**: title, start/end (EAT), affected components and expected customer
impact. Publish **at least 48 hours ahead** for planned downtime. During the window, affected
components show *Scheduled maintenance* and failed checks don't read as outages. If the
work overruns, open an incident.

## Changelog and upcoming features
- **Changelog:** customer-facing release notes (New / Improved / Fixed, with an audience). A future
  date schedules the entry; a draft is hidden.
- **Upcoming:** Planned → In progress → In beta → Shipped. Use loose timing ("Early 2027"), never
  hard dates you can't keep. When a feature ships, add a changelog entry and move or hide the card.

## If the status page itself has a problem
- Public page shows **Status unavailable** for everything: the cron hasn't run for more than 3
  minutes. Check Cloudflare → Workers → fasta-status → Logs. Operators can still publish
  incidents, because those don't depend on the checks.
- Access sign-in broken: use the break-glass `ADMIN_TOKEN` with the admin API, for example:
```bash
curl -X POST https://status.fastadeliveries.co.ke/admin/api/incidents \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Requested-With: fasta-status" -H "Content-Type: application/json" \
  -d '{"title":"…","impact":"partial_outage","components":["checkout"],"message":"…"}'
```
- Delete only **test** incidents. Real incidents stay as public history.
