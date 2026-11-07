import type { CheckDef, ComponentDef, Env, PendingCheck } from './types';

/** Public components, in display order. Ids are stable; names are what customers see. */
export const COMPONENTS: ComponentDef[] = [
  { id: 'storefront', group: 'Customers', name: 'Customer website', description: 'Browsing shops and products at web.fastadeliveries.co.ke' },
  { id: 'signin', group: 'Customers', name: 'Customer sign-in', description: 'Signing in and creating an account on the website and app' },
  { id: 'catalogue', group: 'Customers', name: 'Catalogue', description: 'Shops, categories and products shown to customers' },
  { id: 'checkout', group: 'Customers', name: 'Checkout and payments', description: 'Delivery quotes, checkout and payment options' },
  { id: 'tracking', group: 'Customers', name: 'Order tracking', description: 'Following an order from the store to your door' },
  { id: 'seller', group: 'Sellers', name: 'Seller dashboard', description: 'Seller sign-in, store and order management' },
  { id: 'brandsite', group: 'Sellers', name: 'BrandSite', description: 'Seller storefronts on BrandSite and custom domains' },
  { id: 'riders', group: 'Delivery partners', name: 'Delivery partner app', description: 'Rider sign-in and delivery assignment' },
  { id: 'api', group: 'Platform', name: 'Fasta API', description: 'The core service behind the apps, website and seller tools' },
  { id: 'media', group: 'Platform', name: 'Images and files', description: 'Product photos, logos and uploaded files' },
  { id: 'company', group: 'Platform', name: 'Company website', description: 'fastadeliveries.co.ke information pages' },
];
export const COMPONENT_IDS = COMPONENTS.map((c) => c.id);

/** A page that ends up here is a maintenance or error screen, not the real thing. */
const MAINTENANCE_URL = /mainten|maintain/i;
const NEXT_ERROR_PAGE = ['"page":"/404"', '"page":"/500"', '"page":"/_error"', '"page":"/maintainance"'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const trimSlash = (u: string) => u.replace(/\/+$/, '');
const on = (v?: string, dflt = false) => {
  const s = (v ?? '').trim().toLowerCase();
  return s === '' ? dflt : s === 'true';
};

function parseHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export interface MonitorPlan {
  checks: CheckDef[];
  pending: PendingCheck[];
}

/** Builds the list of live checks from environment variables, plus the checks that are
 *  still waiting on test data so the dashboard (and the docs) can say so honestly.
 *  Every live check is read-only: no SMS, emails, orders or paid third-party calls. */
export function buildPlan(env: Env): MonitorPlan {
  const web = trimSlash(env.STOREFRONT_URL);
  const api = trimSlash(env.API_URL);
  const checks: CheckDef[] = [];
  const pending: PendingCheck[] = [];
  const add = (c: CheckDef) => checks.push(c);
  const wait = (component: string, publicLabel: string, needs: string) => pending.push({ component, publicLabel, needs });

  // --- Customer website -------------------------------------------------------
  add({
    id: 'storefront.home', component: 'storefront', name: 'Storefront homepage renders',
    publicLabel: 'Homepage loads', publicDetail: 'The homepage opens and shows the real store, not an error or maintenance page.',
    depth: 'deep', url: `${web}/`, followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
    mustContain: ['__NEXT_DATA__'], mustNotContain: NEXT_ERROR_PAGE,
  });
  add({
    id: 'storefront.maintenance', component: 'storefront', name: 'Maintenance mode is off (config.maintenance_mode)',
    publicLabel: 'Not in maintenance mode', publicDetail: 'Fasta is open for orders (maintenance mode is switched off).',
    depth: 'deep', url: `${api}/api/v1/config`, followRedirects: false,
    json: [{ path: 'content.maintenance_mode', equals: false, failKind: 'maintenance', explain: 'Maintenance mode is switched ON in Fasta admin' }],
  });
  if (env.STOREFRONT_LISTING_PATH) {
    add({
      id: 'storefront.listing', component: 'storefront', name: 'Known catalogue listing page',
      publicLabel: 'A test store page loads', publicDetail: 'A store page opens with its products.',
      depth: 'deep', url: `${web}${env.STOREFRONT_LISTING_PATH}`, followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
      mustContain: ['__NEXT_DATA__'], mustNotContain: NEXT_ERROR_PAGE,
    });
  } else {
    wait('storefront', 'A test store page loads', 'Set STOREFRONT_LISTING_PATH to a dedicated test store page, e.g. /store/fasta-test-store.');
  }

  // --- Customer sign-in ---------------------------------------------------------
  // An empty request is rejected by validation before any SMS/OTP is sent; a 422 with the
  // expected field error proves the sign-in service and its database are answering.
  add({
    id: 'signin.api', component: 'signin', name: 'POST /api/v1/auth/login (empty → 422 login_type)',
    publicLabel: 'Sign-in service responds', publicDetail: 'The sign-in service answers and validates requests.',
    depth: 'deep', url: `${api}/api/v1/auth/login`, method: 'POST', body: '{}', headers: JSON_HEADERS,
    followRedirects: false, expectStatus: [422],
    json: [{ path: 'errors.0.code', equals: 'login_type' }],
  });

  // --- Catalogue ------------------------------------------------------------------
  if (on(env.CATALOGUE_CHECK, true)) {
    add({
      id: 'catalogue.modules', component: 'catalogue', name: 'GET /api/v1/module returns modules',
      publicLabel: 'Store types are available', publicDetail: 'The list of store types (food, grocery, pharmacy…) is available.',
      depth: 'deep', url: `${api}/api/v1/module`, followRedirects: false,
      json: [{ path: 'content.data', type: 'array', nonEmpty: true, explain: 'No modules (store types) are set up in Fasta admin' }],
    });
    add({
      id: 'catalogue.categories', component: 'catalogue', name: 'GET /api/v1/categories returns categories',
      publicLabel: 'Product categories load', publicDetail: 'Product categories load for customers.',
      depth: 'deep', url: `${api}/api/v1/categories`, headers: { zoneId: env.CATALOGUE_ZONE_IDS || '[1]' }, followRedirects: false,
      json: [{ path: 'content.data', type: 'array', nonEmpty: true, explain: 'No product categories returned' }],
    });
  } else {
    wait('catalogue', 'Store types and categories load', 'Turned off (CATALOGUE_CHECK=false). Turn on once zones and modules are set up in Fasta admin.');
  }

  // --- Checkout and payments -----------------------------------------------------------
  add({
    id: 'checkout.methods', component: 'checkout', name: 'A payment method is enabled (config)',
    publicLabel: 'A payment method is available', publicDetail: 'At least one way to pay is switched on (cash on delivery or an online gateway).',
    depth: 'deep', url: `${api}/api/v1/config`, followRedirects: false,
    json: [{
      path: 'content', explain: 'No payment method is enabled (cash on delivery off and no online gateway)',
      anyOf: [
        { path: 'content.cash_on_delivery', equals: true },
        { path: 'content.active_payment_method_list', type: 'array', nonEmpty: true },
      ],
    }],
  });
  add({
    id: 'checkout.offline', component: 'checkout', name: 'GET /api/v1/offline_payment_method_list structure',
    publicLabel: 'Payment options service responds', publicDetail: 'The service that lists payment options answers correctly.',
    depth: 'deep', url: `${api}/api/v1/offline_payment_method_list`, followRedirects: false,
    json: [{ path: 'content.data', type: 'array' }],
  });
  if (on(env.CHECKOUT_QUOTE_ENABLED) && env.CHECKOUT_QUOTE_URL) {
    add({
      id: 'checkout.quote', component: 'checkout', name: 'Sandbox delivery quote',
      publicLabel: 'A test cart gets a delivery quote', publicDetail: 'A test order gets a delivery price (sandbox, no real charge).',
      depth: 'deep', url: env.CHECKOUT_QUOTE_URL, method: env.CHECKOUT_QUOTE_BODY ? 'POST' : 'GET',
      body: env.CHECKOUT_QUOTE_BODY, followRedirects: false,
      headers: { ...JSON_HEADERS, ...parseHeaders(env.CHECKOUT_QUOTE_HEADERS) },
      json: [{ path: env.CHECKOUT_QUOTE_EXPECT_PATH || 'content', nonEmpty: true }],
    });
  } else {
    wait('checkout', 'A test cart gets a delivery quote and reaches payment', 'Sandbox/isolated test cart, address and payment gateway. Never point this at live payments.');
  }

  // --- Order tracking -------------------------------------------------------------------
  add({
    id: 'tracking.service', component: 'tracking', name: 'GET /api/v1/customer/order/track (no auth → 401 JSON)',
    publicLabel: 'Tracking service responds', publicDetail: 'The order tracking service answers and protects order details.',
    depth: 'basic', url: `${api}/api/v1/customer/order/track`, followRedirects: false, expectStatus: [401],
    json: [{ path: 'errors.0.code', equals: 'auth-001' }],
  });
  if (on(env.TRACKING_ENABLED) && env.TRACKING_ORDER_ID && env.TRACKING_CONTACT) {
    const q = new URLSearchParams({ order_id: env.TRACKING_ORDER_ID, contact_number: env.TRACKING_CONTACT });
    add({
      id: 'tracking.order', component: 'tracking', name: 'Track dedicated test order',
      publicLabel: 'A test order can be tracked', publicDetail: 'A real (test) order can be looked up and tracked.',
      depth: 'deep', url: `${api}/api/v1/customer/order/track?${q}`, followRedirects: false,
      json: [{ path: 'content', type: 'object', nonEmpty: true }],
    });
  } else {
    wait('tracking', 'A test order can be tracked', 'Create a dedicated test order and set TRACKING_ORDER_ID / TRACKING_CONTACT secrets and TRACKING_ENABLED=true.');
  }

  // --- Seller dashboard ---------------------------------------------------------------
  add({
    id: 'seller.login', component: 'seller', name: `Seller login page (${env.SELLER_LOGIN_PATH})`,
    publicLabel: 'Seller sign-in page loads', publicDetail: 'The seller sign-in page opens in a browser.',
    depth: 'basic', url: `${api}${env.SELLER_LOGIN_PATH}`, followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
    mustContain: ['name="email"', 'login_submit'],
  });
  add({
    id: 'seller.api', component: 'seller', name: 'POST /api/v1/auth/vendor/login (empty → 422 email)',
    publicLabel: 'Seller app sign-in responds', publicDetail: 'The seller app sign-in service answers and validates requests.',
    depth: 'deep', url: `${api}/api/v1/auth/vendor/login`, method: 'POST', body: '{}', headers: JSON_HEADERS,
    followRedirects: false, expectStatus: [422],
    json: [{ path: 'errors.0.code', equals: 'email' }],
  });
  wait('seller', 'A seller dashboard screen loads', 'Dedicated test seller + read-only session check (not built yet; seller login uses a captcha).');

  // --- BrandSite --------------------------------------------------------------------------
  add({
    id: 'brandsite.lookup', component: 'brandsite', name: 'GET /api/v1/brandsite-host/<probe> (unknown host → 404 JSON)',
    publicLabel: 'BrandSite lookup service responds', publicDetail: 'The service that finds a seller’s BrandSite from its web address answers.',
    depth: 'basic', url: `${api}/api/v1/brandsite-host/fasta-status-probe.invalid`, followRedirects: false, expectStatus: [404],
    json: [{ path: 'identical_code', equals: 'default_404' }],
  });
  if (env.BRANDSITE_TEST_SLUG) {
    const slug = encodeURIComponent(env.BRANDSITE_TEST_SLUG);
    add({
      id: 'brandsite.page', component: 'brandsite', name: `Test BrandSite page /brandsite/${slug}`,
      publicLabel: 'A test BrandSite loads', publicDetail: 'A published test BrandSite opens over HTTPS.',
      depth: 'deep', url: `${web}/brandsite/${slug}`, followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
      mustContain: ['__NEXT_DATA__'], mustNotContain: NEXT_ERROR_PAGE,
    });
    add({
      id: 'brandsite.api', component: 'brandsite', name: `GET /api/v1/brandsite/${slug}`,
      publicLabel: 'BrandSite data loads', publicDetail: 'The test BrandSite’s content loads from the API.',
      depth: 'deep', url: `${api}/api/v1/brandsite/${slug}`, followRedirects: false,
      json: [{ path: 'content', type: 'object', nonEmpty: true }],
    });
  } else {
    wait('brandsite', 'A published test BrandSite loads', 'Publish a dedicated test BrandSite and set BRANDSITE_TEST_SLUG.');
  }
  if (env.BRANDSITE_CUSTOM_DOMAIN_URL) {
    add({
      id: 'brandsite.domain', component: 'brandsite', name: 'Test custom domain',
      publicLabel: 'A test custom domain works', publicDetail: 'A seller’s own web address opens their BrandSite.',
      depth: 'deep', url: trimSlash(env.BRANDSITE_CUSTOM_DOMAIN_URL) + '/', followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
      mustContain: ['__NEXT_DATA__'], mustNotContain: NEXT_ERROR_PAGE,
    });
  } else {
    wait('brandsite', 'A test custom domain works', 'Verify a test custom domain through the BrandSite DNS flow and set BRANDSITE_CUSTOM_DOMAIN_URL.');
  }

  // --- Delivery partner app ----------------------------------------------------------------
  add({
    id: 'riders.api', component: 'riders', name: 'POST /api/v1/auth/delivery-man/login (empty → 422 phone)',
    publicLabel: 'Rider sign-in responds', publicDetail: 'The delivery partner sign-in service answers and validates requests.',
    depth: 'deep', url: `${api}/api/v1/auth/delivery-man/login`, method: 'POST', body: '{}', headers: JSON_HEADERS,
    followRedirects: false, expectStatus: [422],
    json: [{ path: 'errors.0.code', equals: 'phone' }],
  });
  add({
    id: 'riders.vehicles', component: 'riders', name: 'GET /api/v1/get-vehicles structure',
    publicLabel: 'Vehicle list service responds', publicDetail: 'The service that lists delivery vehicles answers correctly.',
    depth: 'deep', url: `${api}/api/v1/get-vehicles`, followRedirects: false,
    json: [{ path: 'content.data', type: 'array' }],
  });

  // --- Fasta API --------------------------------------------------------------------------
  add({
    id: 'api.up', component: 'api', name: 'Laravel /up health route',
    publicLabel: 'Health check passes', publicDetail: 'The server reports itself healthy.',
    depth: 'basic', url: `${api}/up`, followRedirects: false, mustContain: ['Application up'],
  });
  add({
    id: 'api.config', component: 'api', name: 'GET /api/v1/config structure',
    publicLabel: 'App settings load', publicDetail: 'The settings every app and the website load at start-up are complete.',
    depth: 'deep', url: `${api}/api/v1/config`, followRedirects: false,
    json: [{ path: 'content.business_name', type: 'string', nonEmpty: true }],
  });
  add({
    id: 'api.landing', component: 'api', name: 'GET /api/v1/react-landing-page structure',
    publicLabel: 'Homepage content loads', publicDetail: 'The website’s homepage content loads from the database.',
    depth: 'deep', url: `${api}/api/v1/react-landing-page`, followRedirects: false,
    json: [{ path: 'content.hero_section', type: 'object', nonEmpty: true }],
  });

  // --- Images and files ------------------------------------------------------------------
  add({
    id: 'media.logo', component: 'media', name: 'Logo image from config.logo_full_url',
    publicLabel: 'Uploaded images load', publicDetail: 'Uploaded images (here, the Fasta logo) download correctly.',
    depth: 'deep', url: `${api}/api/v1/config`, urlFrom: { url: `${api}/api/v1/config`, path: 'content.logo_full_url' },
    followRedirects: true, contentType: 'image/',
  });

  // --- Company website --------------------------------------------------------------------
  add({
    id: 'company.about', component: 'company', name: 'Company page /about-us',
    publicLabel: 'Company pages load', publicDetail: 'The company information pages open.',
    depth: 'basic', url: `${api}/about-us`, followRedirects: true, forbidFinalUrl: MAINTENANCE_URL,
    mustContain: ['<html'],
  });

  return { checks, pending };
}

export function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function settings(env: Env) {
  return {
    timeoutMs: num(env.CHECK_TIMEOUT_MS, 10_000),
    slowMs: num(env.SLOW_RESPONSE_MS, 5_000),
    failThreshold: num(env.FAIL_THRESHOLD, 3),
    recoverThreshold: num(env.RECOVER_THRESHOLD, 2),
    staleMs: num(env.STALE_AFTER_SECONDS, 180) * 1000,
  };
}
