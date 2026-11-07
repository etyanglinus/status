// Local stand-in for Fasta (storefront + Laravel) used to rehearse outages without
// touching staging or production. Also captures alert webhooks at /hook.
//   node scripts/fake-fasta.mjs            (listens on :8790)
//   curl 'localhost:8790/_mode?api=down'   modes: ok | down | wrong | slow | empty | maintenance
import http from 'node:http';

const mode = { storefront: 'ok', api: 'ok', seller: 'ok' };
const alerts = [];
const send = (res, status, body, type = 'text/html', headers = {}) => {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(body);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_mode') {
    for (const [k, v] of url.searchParams) mode[k] = v;
    return send(res, 200, JSON.stringify(mode), 'application/json');
  }
  if (url.pathname === '/hook') {
    let b = ''; for await (const c of req) b += c;
    alerts.push(JSON.parse(b).text);
    return send(res, 200, 'ok');
  }
  if (url.pathname === '/_alerts') return send(res, 200, JSON.stringify(alerts), 'application/json');

  const host = req.headers.host || '';
  const isWeb = host.startsWith('127.0.0.1');   // storefront on 127.0.0.1, "Laravel" on localhost
  const m = isWeb ? mode.storefront : (url.pathname.startsWith('/login') ? mode.seller : mode.api);
  if (isWeb && url.pathname === '/maintainance') return send(res, 200, '<script id="__NEXT_DATA__">{"page":"/maintainance"}</script>');
  if (m === 'down') { req.socket.destroy(); return; }
  if (m === 'slow') await new Promise((r) => setTimeout(r, 4500));
  if (m === 'maintenance') return send(res, 307, '/maintainance', 'text/plain', { Location: '/maintainance' });

  if (isWeb) {
    if (url.pathname === '/maintainance') return send(res, 200, '<script id="__NEXT_DATA__">{"page":"/maintainance"}</script>');
    if (m === 'wrong') return send(res, 200, '<h1>Default nginx page</h1>');
    return send(res, 200, '<html><script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script></html>');
  }
  const J = (status, obj) => send(res, status, JSON.stringify(obj), 'application/json');
  const err = (status, code, ident) => J(status, { identical_code: ident, content: null, errors: [{ code, message: code }] });
  if (url.pathname === '/up') return send(res, 200, m === 'wrong' ? '<h1>Hello</h1>' : '<div>Application up</div>');
  if (url.pathname === '/api/v1/config') return J(200, m === 'wrong' ? { content: {} } : { content: {
    business_name: 'Fasta Deliveries', maintenance_mode: m === 'maintenance-flag', cash_on_delivery: true, active_payment_method_list: [],
    logo_full_url: 'http://localhost:8790/logo.png' } });
  if (url.pathname === '/logo.png') return send(res, 200, 'PNGDATA', 'image/png');
  if (url.pathname === '/api/v1/auth/login') return err(422, 'login_type', 'unprocessable_entity_422');
  if (url.pathname === '/api/v1/auth/vendor/login') return err(422, 'email', 'unprocessable_entity_422');
  if (url.pathname === '/api/v1/auth/delivery-man/login') return err(422, 'phone', 'unprocessable_entity_422');
  if (url.pathname === '/api/v1/customer/order/track') return err(401, 'auth-001', 'unauthorized_401');
  if (url.pathname.startsWith('/api/v1/brandsite-host/')) return err(404, 'not-found', 'default_404');
  if (url.pathname === '/api/v1/categories') return J(200, { content: { data: m === 'empty' ? [] : [{ id: 1 }] } });
  if (url.pathname === '/api/v1/offline_payment_method_list' || url.pathname === '/api/v1/get-vehicles') return J(200, { content: { data: [] } });
  if (url.pathname === '/api/v1/react-landing-page') return J(200, { content: { hero_section: { header_title: 'Fasta' } } });
  if (url.pathname === '/about-us') return send(res, 200, '<html><body>About Fasta</body></html>');
  if (url.pathname === '/api/v1/module') return send(res, 200, JSON.stringify({ content: { data: m === 'empty' ? [] : [{ id: 1 }] } }), 'application/json');
  if (url.pathname.startsWith('/login/vendor')) return send(res, 200, m === 'wrong' ? '<h1>Error</h1>' : '<form action="login_submit"><input name="email"></form>');
  send(res, 404, 'not found');
}).listen(8790, () => console.log('fake fasta on :8790'));
