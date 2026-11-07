export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  STOREFRONT_URL: string;
  API_URL: string;
  SELLER_LOGIN_PATH: string;
  STOREFRONT_LISTING_PATH?: string;
  BRANDSITE_TEST_SLUG?: string;
  BRANDSITE_CUSTOM_DOMAIN_URL?: string;
  TRACKING_ENABLED?: string;
  TRACKING_ORDER_ID?: string;
  TRACKING_CONTACT?: string;
  CHECKOUT_QUOTE_ENABLED?: string;
  CHECKOUT_QUOTE_URL?: string;
  CHECKOUT_QUOTE_BODY?: string;
  CHECKOUT_QUOTE_HEADERS?: string;
  CHECKOUT_QUOTE_EXPECT_PATH?: string;
  CHECK_TIMEOUT_MS?: string;
  SLOW_RESPONSE_MS?: string;
  FAIL_THRESHOLD?: string;
  RECOVER_THRESHOLD?: string;
  STALE_AFTER_SECONDS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_TOKEN?: string;
  ADMIN_USERS?: string;      // JSON {email: pbkdf2 hash}, set by `npm run setup`
  SESSION_SECRET?: string;   // 32+ random chars, set by `npm run setup`
  CATALOGUE_CHECK?: string;  // "false" turns off the catalogue checks
  CATALOGUE_ZONE_IDS?: string; // zoneId header for the categories check, e.g. "[1]"
  DEV_ADMIN_EMAIL?: string;  // local development only (set in .dev.vars)
  PUBLIC_URL?: string;
  PUBLIC_CACHE_SECONDS?: string;
  DASHBOARD_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERT_WEBHOOK_URL?: string;
}

/** Raw result of a single check run. */
export type Outcome = 'up' | 'degraded' | 'down';

/** Public component statuses (brief §4.3) plus "unmonitored" for components that
 *  have no automated check yet and are updated by operators only. */
export type ComponentStatus =
  | 'operational'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage'
  | 'maintenance'
  | 'unavailable'
  | 'unmonitored';

export type Impact = 'degraded' | 'partial_outage' | 'major_outage';
export type Stage = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface JsonExpectation {
  path: string;                       // dot path, e.g. "content.business_name" or "errors.0.code"
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  nonEmpty?: boolean;                 // strings/arrays/objects must not be empty
  equals?: string | number | boolean;
  /** Passes if ANY of these rules passes (e.g. "cash on delivery OR an online gateway"). */
  anyOf?: JsonExpectation[];
  /** Plain-language failure used when this rule fails (private, admin/alerts). */
  explain?: string;
  /** Public failure category to report when this rule fails (default: structure/empty). */
  failKind?: FailureKind;
}

/** Why a check failed, in categories that are safe to show the public. */
export type FailureKind =
  | 'ok' | 'slow' | 'timeout' | 'connection' | 'server_error' | 'client_error'
  | 'maintenance' | 'redirect' | 'content' | 'structure' | 'empty';

export interface CheckDef {
  id: string;
  component: string;
  /** Short operator-facing name. The public page shows only `publicLabel`/`publicDetail`. */
  name: string;
  publicLabel: string;
  /** One sentence for customers: what this check proves when it passes. */
  publicDetail?: string;
  depth: 'basic' | 'deep';
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  expectStatus?: number[];
  /** Follow redirects? When false, any 3xx is a failure unless allowRedirect matches. */
  followRedirects?: boolean;
  allowRedirect?: RegExp;
  forbidFinalUrl?: RegExp;
  mustContain?: string[];
  mustNotContain?: string[];
  json?: JsonExpectation[];
  /** Response Content-Type must start with this (e.g. "image/"). */
  contentType?: string;
  /** Fetch `from`, read the URL at JSON `path`, then check that URL instead (e.g. the logo image). */
  urlFrom?: { url: string; path: string };
  /** Per-check "slow" threshold in ms (default SLOW_RESPONSE_MS). */
  slowMs?: number;
}

export interface PendingCheck {
  component: string;
  publicLabel: string;
  needs: string;   // what test setup is still required (operator dashboard only)
}

export interface ComponentDef {
  id: string;
  name: string;
  description: string;
  group: string;
}

export interface CheckStateRow {
  check_id: string;
  state: Outcome;
  fail_streak: number;
  slow_streak: number;
  ok_streak: number;
  up_streak: number;
  first_failure_at: number | null;
  down_since: number | null;
  last_outcome: Outcome | null;
  last_reason: string | null;
  last_kind?: FailureKind | null;
  last_status: number | null;
  last_latency_ms: number | null;
  last_result_at: number | null;
}

export interface CheckResult {
  outcome: Outcome;
  kind: FailureKind;
  reason: string;
  status: number | null;
  latencyMs: number;
}
