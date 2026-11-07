# What Fasta Status checks

Fasta Status runs **18 automated checks every minute** across **11 services**, from Cloudflare's network
(separate from your cPanel server). Every check is **read-only**: none sends an SMS or email, creates an
order, charges money, or calls a paid Google API.

All 18 were run against the live Fasta servers on 7 Nov 2026. 17 passed. The catalogue "store types"
check failed because no modules are set up yet; that's a real finding.

## How a check decides "working"
A check passes only if **all** of these are true:
1. The server answered within **10 seconds** (`CHECK_TIMEOUT_MS`).
2. The HTTP status code is the one expected (usually 200; some checks expect an error code on purpose, see below).
3. It did **not** end on a maintenance page or a Next.js error page.
4. The content or JSON structure is right (for example, the field exists and isn't empty).

If it passes but took longer than **5 seconds** (`SLOW_RESPONSE_MS`), it counts as **slow**.

## From one result to a public status
| Rule | Setting |
|---|---|
| A check is **failing** after 3 failed results in a row | `FAIL_THRESHOLD = 3` |
| A check is **slow** after 3 slow or failed results in a row | same |
| A failing check **recovers** after 2 good results in a row | `RECOVER_THRESHOLD = 2` |
| Service: **all** its checks failing | **Major outage** |
| Service: **some** checks failing | **Partial outage** |
| Service: any check slow | **Degraded performance** |
| No new results for 3 minutes | **Status unavailable** (shows last confirmed result) |
| An open incident or maintenance window | Overrides the measured status (only ever to show something **worse** than measured, or "maintenance") |

## The 18 checks

### Customers
| Service | Public label | What is requested | Passes when |
|---|---|---|---|
| Customer website | Homepage loads | `GET web.fastadeliveries.co.ke/` | 200, contains `__NEXT_DATA__`, not redirected to `/maintainance`, not a 404/500 page |
| Customer website | Not in maintenance mode | `GET /api/v1/config` | `content.maintenance_mode` is `false` |
| Customer sign-in | Sign-in service responds | `POST /api/v1/auth/login` with an **empty** body | **422** with `errors[0].code = "login_type"` (validation runs before any SMS/OTP) |
| Catalogue | Store types are available | `GET /api/v1/module` | `content.data` is a non-empty list (**fails today: 0 modules**) |
| Catalogue | Product categories load | `GET /api/v1/categories` with header `zoneId: [1]` | `content.data` is a non-empty list |
| Checkout and payments | A payment method is available | `GET /api/v1/config` | cash on delivery is on **or** `active_payment_method_list` is not empty |
| Checkout and payments | Payment options service responds | `GET /api/v1/offline_payment_method_list` | 200 with `content.data` as a list (empty is OK) |
| Order tracking | Tracking service responds | `GET /api/v1/customer/order/track` without signing in | **401** with `errors[0].code = "auth-001"` (it's up and protects orders) |

### Sellers
| Service | Public label | What is requested | Passes when |
|---|---|---|---|
| Seller dashboard | Seller sign-in page loads | `GET /login/vendor` | 200, contains the email field and `login_submit`, not maintenance |
| Seller dashboard | Seller app sign-in responds | `POST /api/v1/auth/vendor/login` with an empty body | **422** with `errors[0].code = "email"` |
| BrandSite | BrandSite lookup service responds | `GET /api/v1/brandsite-host/fasta-status-probe.invalid` | **404** with `identical_code = "default_404"` (unknown address → correct "not found") |

### Delivery partners
| Service | Public label | What is requested | Passes when |
|---|---|---|---|
| Delivery partner app | Rider sign-in responds | `POST /api/v1/auth/delivery-man/login` with an empty body | **422** with `errors[0].code = "phone"` |
| Delivery partner app | Vehicle list service responds | `GET /api/v1/get-vehicles` | 200 with `content.data` as a list |

### Platform
| Service | Public label | What is requested | Passes when |
|---|---|---|---|
| Fasta API | Health check passes | `GET /up` | body contains `Application up` |
| Fasta API | App settings load | `GET /api/v1/config` | `content.business_name` is a non-empty text |
| Fasta API | Homepage content loads | `GET /api/v1/react-landing-page` | `content.hero_section` exists and isn't empty |
| Images and files | Uploaded images load | reads `content.logo_full_url` from `/api/v1/config`, then downloads it | response is an `image/*` file and not empty |
| Company website | Company pages load | `GET fastadeliveries.co.ke/about-us` | 200 HTML page, not maintenance |

**Why some checks expect an error on purpose:** sending an empty sign-in form is the safest way to prove the
sign-in service, its code and its database are running. It's rejected before anything is sent to anyone. If the
server crashed instead (500), timed out, or returned a different error, the check fails.

**Load on your server:** about 16 requests a minute, because three checks share one `/api/v1/config` request.
That's roughly 23,000 small requests a day, which is negligible for a web server.

## Waiting on test data (shown as "coming soon")
| Service | Check | What you need to do | Then set (in `wrangler.toml` unless marked *secret*) |
|---|---|---|---|
| Customer website | A test store page loads | Create a store called e.g. "Fasta Test Store" that is always open | `STOREFRONT_LISTING_PATH = "/store/<its-slug>"` |
| Checkout and payments | A test cart gets a delivery quote | A **sandbox** payment gateway and an isolated test zone/store (never live payments) | `CHECKOUT_QUOTE_ENABLED = "true"` and secrets `CHECKOUT_QUOTE_URL`, `CHECKOUT_QUOTE_BODY`, `CHECKOUT_QUOTE_HEADERS`, `CHECKOUT_QUOTE_EXPECT_PATH` |
| Order tracking | A test order can be tracked | Place one test order, never fulfil or delete it | `TRACKING_ENABLED = "true"`; secrets `TRACKING_ORDER_ID`, `TRACKING_CONTACT` |
| Seller dashboard | A seller dashboard screen loads | Needs a token-based test-seller login (the web login has a captcha) | not built yet |
| BrandSite | A published test BrandSite loads | Publish a BrandSite for the test store | `BRANDSITE_TEST_SLUG = "<slug>"` |
| BrandSite | A test custom domain works | Connect a spare domain to the test BrandSite | `BRANDSITE_CUSTOM_DOMAIN_URL = "https://…"` |

Set a secret with `npx wrangler secret put NAME` (it asks for the value), then run `npm run update`.

## What the public sees, and what stays private
| Shown publicly | Only in `/admin` and alerts |
|---|---|
| Service status, each check's label and status | The exact URL, method and expected code |
| A plain-language problem, e.g. "Not responding (timed out)", "Showing a maintenance page", "Returning no data" | The technical reason, e.g. `JSON field "content.data" is empty`, `HTTP 502` |
| Response times, uptime 24h/7d/30d/90d, 24-hour chart | Streak counters, first-failure time |
| Detected problem periods (service, what happened, start, end) | Full alert log, which alerts were delivered |
