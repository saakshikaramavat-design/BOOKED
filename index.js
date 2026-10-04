// BOOKED mock server: Delhivery /matrix + Pine Labs orders/payments (UPI) + a payment approval page
const SRC = [19.1207146, 72.8487608];
const KNOWN = [
  { lat: 19.2198595, lng: 72.8457152, distance: 14.986, time: 2056 },
  { lat: 18.9866214, lng: 72.8154765, distance: 19.346, time: 2082 },
  { lat: 19.0638364, lng: 72.8659918, distance: 11.727, time: 2198 }
];
const near = (a, b) => Math.abs(a - b) < 0.0005;
const hav = (a, b) => { const R = 6371, r = x => x * Math.PI / 180; const dLat = r(b[0]-a[0]), dLng = r(b[1]-a[1]);
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a[0]))*Math.cos(r(b[0]))*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); };
const rid = () => Math.random().toString(16).slice(2, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const orders = globalThis.__orders || (globalThis.__orders = new Map()); // demo memory

function authOk(req) { const a = req.headers['authorization'] || ''; return a.startsWith('Bearer ') && a.length >= 12; }
const now = () => new Date().toISOString();

async function simulate(req, res) {
  const sim = (req.query && req.query.simulate) || '';
  if (sim === 'timeout') { await sleep(25000); res.status(504).json({ status: false, message: 'Gateway timeout' }); return true; }
  if (sim === 'malformed') { res.status(200).send('{"data":{"order_id":'); return true; }
  if (sim === 'server_error') { res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal error' }); return true; }
  return false;
}

async function matrix(req, res) {
  if (!authOk(req)) return res.status(401).json({ status: false, message: 'Unauthorized: missing or invalid token' });
  if (await simulate(req, res)) return;
  const b = req.body || {};
  const ok = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!Array.isArray(b.sources) || !Array.isArray(b.targets) || !b.sources.length || !b.targets.length || !b.sources.every(ok) || !b.targets.every(ok))
    return res.status(400).json({ status: false, message: 'Invalid sources or targets. Use [[lat, lng], ...]' });
  const mode = b.travel_mode || 'auto';
  if (!['auto', 'motorcycle', 'truck', 'pedestrian'].includes(mode)) return res.status(400).json({ status: false, message: 'Invalid travel_mode' });
  const inM = p => p[0] > 18.8 && p[0] < 19.5 && p[1] > 72.7 && p[1] < 73.1;
  const rows = b.sources.map((s, i) => b.targets.map((t, j) => {
    if (!inM(s) || !inM(t)) return { from_index: i, to_index: j, distance: null, time: null, error: 'NO_ROUTE_FOUND' };
    const k = KNOWN.find(v => near(v.lat, t[0]) && near(v.lng, t[1]));
    let distance, time;
    if (k && near(s[0], SRC[0]) && near(s[1], SRC[1]) && mode === 'auto') { distance = k.distance; time = k.time; }
    else { distance = +(hav(s, t) * 1.3).toFixed(3); time = Math.round(distance / ({ auto: 26, motorcycle: 30, truck: 20, pedestrian: 5 }[mode]) * 3600); }
    return { begin_lat: +s[0].toFixed(6), begin_lon: +s[1].toFixed(6), distance, end_lat: +t[0].toFixed(6), end_lon: +t[1].toFixed(6), from_index: i, time, to_index: j };
  }));
  res.status(200).json({ request_id: 'mock-' + rid(), sources_to_targets: rows, status: !rows.every(r => r.every(c => c.error)) });
}

const view = o => ({ order_id: o.id, merchant_order_reference: o.ref, type: 'CHARGE', status: o.status, ...(o.challenge_url ? { challenge_url: o.challenge_url } : {}),
  order_amount: o.amount, ...(o.payment ? { payments: [o.payment] } : {}), integration_mode: 'SEAMLESS', payment_retries_remaining: 10, created_at: o.created_at, updated_at: now() });

async function createOrder(req, res) {
  if (!authOk(req)) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing token' });
  if (await simulate(req, res)) return;
  const b = req.body || {}; const a = b.order_amount || {};
  if (!b.merchant_order_reference || typeof b.merchant_order_reference !== 'string') return res.status(400).json({ code: 'INVALID_REQUEST', message: 'merchant_order_reference is required' });
  if (!Number.isInteger(a.value) || a.value < 100) return res.status(400).json({ code: 'INVALID_AMOUNT', message: 'order_amount.value must be an integer in paise, minimum 100' });
  if (a.currency !== 'INR') return res.status(400).json({ code: 'INVALID_CURRENCY', message: 'currency must be INR' });
  for (const o of orders.values()) if (o.ref === b.merchant_order_reference) return res.status(409).json({ code: 'DUPLICATE_ORDER', message: 'merchant_order_reference already used' });
  const id = 'v1-' + Math.floor(Math.random() * 1e10) + '-aa-' + rid();
  const o = { id, ref: b.merchant_order_reference, amount: { value: a.value, currency: 'INR' }, status: 'CREATED', created_at: now() };
  orders.set(id, o);
  res.status(200).json({ data: view(o) });
}

async function createPayment(req, res, id) {
  if (!authOk(req)) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing token' });
  if (await simulate(req, res)) return;
  const o = orders.get(id);
  if (!o) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
  const p = ((req.body || {}).payments || [])[0];
  if (!p || !p.merchant_payment_reference || !p.payment_amount || p.payment_method !== 'UPI') return res.status(400).json({ code: 'INVALID_REQUEST', message: 'payments[0] needs merchant_payment_reference, payment_amount and payment_method UPI' });
  if (p.payment_amount.value !== o.amount.value) return res.status(400).json({ code: 'AMOUNT_MISMATCH', message: 'payment_amount must equal order_amount' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  o.challenge_url = 'https://' + host + '/pay/' + id;
  o.payment = { id: 'v1-' + Math.floor(Math.random() * 1e10) + '-aa-' + rid() + '-cc-l', merchant_payment_reference: p.merchant_payment_reference, status: 'PENDING', payment_amount: p.payment_amount, payment_method: 'UPI', payment_option: p.payment_option };
  o.status = 'CREATED';
  res.status(200).json({ data: view(o) });
}

async function getOrder(req, res, id) {
  if (!authOk(req)) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or missing token' });
  if (await simulate(req, res)) return;
  const o = orders.get(id);
  if (!o) return res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
  res.status(200).json({ data: view(o) });
}

function page(o, msg) {
  const rs = (o.amount.value / 100).toLocaleString('en-IN');
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay</title><body style="font-family:sans-serif;max-width:420px;margin:40px auto;padding:16px">
<h2>Pine Labs UPI (demo)</h2><p>Order: ${o.ref}</p><p style="font-size:28px"><b>Rs ${rs}</b></p><p>Status: <b>${o.payment ? o.payment.status : o.status}</b> ${msg || ''}</p>
${o.status === 'PROCESSED' || o.status === 'FAILED' ? '' : `<form method=post action="/pay/${o.id}/approve"><button style="font-size:20px;padding:12px 24px;background:#1a7f37;color:#fff;border:0;border-radius:8px">Approve payment</button></form><br>
<form method=post action="/pay/${o.id}/decline"><button style="padding:8px 16px">Decline</button></form>`}</body>`;
}

module.exports = async (req, res) => {
  const path = (req.url || '').split('?')[0].replace(/\/+$/, '');
  let m;
  if (path === '/matrix' && req.method === 'POST') return matrix(req, res);
  if (path === '/api/pay/v1/orders' && req.method === 'POST') return createOrder(req, res);
  if ((m = path.match(/^\/api\/pay\/v1\/orders\/([^/]+)\/payments$/)) && req.method === 'POST') return createPayment(req, res, m[1]);
  if ((m = path.match(/^\/api\/pay\/v1\/orders\/([^/]+)$/)) && req.method === 'GET') return getOrder(req, res, m[1]);
  if ((m = path.match(/^\/pay\/([^/]+)$/)) && req.method === 'GET') { const o = orders.get(m[1]); if (!o) return res.status(404).send('Order not found (server restarted?)'); return res.status(200).setHeader('Content-Type', 'text/html').send(page(o)); }
  if ((m = path.match(/^\/pay\/([^/]+)\/(approve|decline)$/)) && req.method === 'POST') {
    const o = orders.get(m[1]); if (!o) return res.status(404).send('Order not found');
    if (o.status === 'CREATED') { o.status = m[2] === 'approve' ? 'PROCESSED' : 'FAILED'; if (o.payment) o.payment.status = o.status; }
    return res.status(200).setHeader('Content-Type', 'text/html').send(page(o, m[2] === 'approve' ? '- Payment successful. Go back to the chat.' : '- Payment declined.'));
  }
  res.status(404).json({ message: 'Not found' });
};
