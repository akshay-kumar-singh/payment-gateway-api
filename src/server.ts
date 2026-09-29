/**
 * The payment gateway.
 *
 * Two surfaces in one process:
 *   /pg/*       the REST API the server SDK calls (secret key required)
 *   /checkout   the hosted checkout page the browser SDK opens (no secret)
 *
 * Keeping them together makes this deployable as one service. A production gateway
 * splits them: the API scales on throughput, the checkout on page loads.
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_ANY_ORIGIN, ORDER_TTL_MS, findMerchant, idempotency, merchantByMid,
  newSessionId, orders, payments, ref, refunds, sessions,
  type Order, type Payment,
} from './store.js';
import { outcomeFor } from './simulate.js';
import { dispatch } from './webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const fail = (res: express.Response, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

/* ------------------------------------------------------------------ auth */

/** Secret-key auth. Only ever satisfied from a server — never a browser. */
function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  const clientId = String(req.header('x-client-id') ?? '');
  const clientSecret = String(req.header('x-client-secret') ?? '');
  const merchant = findMerchant(clientId, clientSecret);
  if (!merchant) return fail(res, 401, 'AUTH_FAILED', 'Invalid x-client-id or x-client-secret');
  (req as any).merchant = merchant;
  next();
}

const toOrderJson = (o: Order) => ({
  orderId: o.orderId,
  orderStatus: o.status,
  orderAmount: o.amountPaise / 100,
  orderCurrency: o.currency,
  paymentSessionId: o.paymentSessionId,
  customerDetails: o.customer,
  orderNote: o.note,
  orderTags: o.tags,
  createdAt: new Date(o.createdAt).toISOString(),
  orderExpiryTime: new Date(o.expiresAt).toISOString(),
});

const toPaymentJson = (p: Payment) => ({
  paymentId: p.paymentId,
  orderId: p.orderId,
  paymentStatus: p.status,
  paymentAmount: p.amountPaise / 100,
  paymentCurrency: 'INR',
  paymentMethod: p.method,
  paymentMessage: p.message,
  bankReference: p.bankReference,
  paymentTime: new Date(p.createdAt).toISOString(),
  errorCode: p.errorCode,
});

/* ----------------------------------------------------------- merchant API */

app.post('/pg/orders', authenticate, async (req, res) => {
  const merchant = (req as any).merchant;
  const b = req.body ?? {};

  const amountPaise = Number(b.order_amount_paise);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    return fail(res, 400, 'INVALID_AMOUNT', 'order_amount_paise must be an integer of at least 100');
  }
  if (!b.customer_details?.customer_phone) {
    return fail(res, 400, 'INVALID_CUSTOMER', 'customer_details.customer_phone is required');
  }

  // Idempotency: a retried request returns the original order, never a second charge.
  const idemKey = req.header('x-idempotency-key');
  if (idemKey) {
    const existing = idempotency.get(`${merchant.mid}:${idemKey}`);
    if (existing) return res.json(toOrderJson(orders.get(existing)!));
  }

  const orderId = String(b.order_id ?? ref('order'));
  if (orders.has(orderId)) return fail(res, 409, 'DUPLICATE_ORDER', `Order ${orderId} already exists`);

  const now = Date.now();
  const order: Order = {
    orderId,
    mid: merchant.mid,
    amountPaise,
    currency: b.order_currency ?? 'INR',
    status: 'ACTIVE',
    paymentSessionId: newSessionId(),
    customer: {
      customerId: b.customer_details.customer_id ?? 'cust',
      customerPhone: b.customer_details.customer_phone,
      customerEmail: b.customer_details.customer_email,
      customerName: b.customer_details.customer_name,
    },
    returnUrl: b.order_meta?.return_url,
    note: b.order_note,
    tags: b.order_tags,
    createdAt: now,
    expiresAt: now + ORDER_TTL_MS,
  };

  orders.set(orderId, order);
  sessions.set(order.paymentSessionId, orderId);
  if (idemKey) idempotency.set(`${merchant.mid}:${idemKey}`, orderId);

  res.status(200).json(toOrderJson(order));
});

app.get('/pg/orders', authenticate, (req, res) => {
  const mid = (req as any).merchant.mid;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

  // Newest first, so a cursor means "everything older than this order".
  const mine = [...orders.values()]
    .filter((o) => o.mid === mid)
    .sort((a, b) => b.createdAt - a.createdAt || a.orderId.localeCompare(b.orderId));

  // Cursor is an orderId. Keyset paging, not offset: inserting a new order while
  // the merchant pages through cannot shift rows and make them skip one.
  const from = cursor ? mine.findIndex((o) => o.orderId === cursor) : 0;
  if (cursor && from === -1) {
    return fail(res, 400, 'INVALID_CURSOR', 'That cursor does not match any order');
  }

  const page = mine.slice(from, from + limit);
  const next = mine[from + limit];

  res.json({
    data: page.map(toOrderJson),
    // Present only when there is more. Absent means you have reached the end.
    nextCursor: next ? next.orderId : undefined,
    hasMore: Boolean(next),
  });
});

app.get('/pg/orders/:orderId', authenticate, (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.mid !== (req as any).merchant.mid) {
    return fail(res, 404, 'ORDER_NOT_FOUND', 'No such order');
  }
  settlePending(order.orderId);
  res.json(toOrderJson(orders.get(order.orderId)!));
});

app.get('/pg/orders/:orderId/payments', authenticate, (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.mid !== (req as any).merchant.mid) {
    return fail(res, 404, 'ORDER_NOT_FOUND', 'No such order');
  }
  settlePending(order.orderId);
  res.json([...payments.values()].filter((p) => p.orderId === order.orderId).map(toPaymentJson));
});

app.get('/pg/payments/:paymentId', authenticate, (req, res) => {
  const payment = payments.get(req.params.paymentId);
  if (!payment || payment.mid !== (req as any).merchant.mid) {
    return fail(res, 404, 'PAYMENT_NOT_FOUND', 'No such payment');
  }
  settlePending(payment.orderId);
  res.json(toPaymentJson(payments.get(payment.paymentId)!));
});

app.post('/pg/orders/:orderId/refunds', authenticate, (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.mid !== (req as any).merchant.mid) {
    return fail(res, 404, 'ORDER_NOT_FOUND', 'No such order');
  }
  if (order.status !== 'PAID') return fail(res, 409, 'ORDER_NOT_PAID', 'Only a paid order can be refunded');

  const paid = [...payments.values()].find((p) => p.orderId === order.orderId && p.status === 'SUCCESS')!;
  const amountPaise = Number(req.body?.refund_amount_paise ?? order.amountPaise);
  if (amountPaise > order.amountPaise) {
    return fail(res, 400, 'REFUND_TOO_LARGE', 'Refund exceeds the captured amount');
  }

  const refund = {
    refundId: String(req.body?.refund_id ?? ref('refund')),
    orderId: order.orderId,
    paymentId: paid.paymentId,
    amountPaise,
    status: 'SUCCESS' as const,
    note: req.body?.refund_note,
    createdAt: Date.now(),
  };
  refunds.set(refund.refundId, refund);
  res.json({
    refundId: refund.refundId, orderId: refund.orderId, paymentId: refund.paymentId,
    refundAmount: amountPaise / 100, refundStatus: refund.status,
    refundNote: refund.note, createdAt: new Date(refund.createdAt).toISOString(),
  });
});

/* -------------------------------------------------------- checkout (public)
   These are called by the checkout page itself. They are scoped to one session id,
   which is unguessable and expires — so no secret key is needed or wanted here. */

app.get('/checkout', (req, res) => {
  // Domain whitelisting, enforced by the BROWSER.
  //
  // frame-ancestors tells the browser which sites may embed this page. An origin the
  // merchant never registered cannot render the checkout at all — the browser refuses
  // before any of our JavaScript runs, so it cannot be bypassed from the embedding page.
  const orderId = sessions.get(String(req.query.session ?? ''));
  const order = orderId ? orders.get(orderId) : undefined;
  const merchant = order ? merchantByMid(order.mid) : undefined;

  if (merchant) {
    // ALLOWED_ORIGINS=* opens the sandbox to any site so the published SDKs work
    // from wherever someone is trying them. Never do this with real money.
    const ancestors = ALLOW_ANY_ORIGIN ? '*' : merchant.allowedOrigins.join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${ancestors}`);
  }
  // Unknown session: no header. There is nothing to protect, and the page needs to be
  // able to render its "invalid session" message wherever it was opened.

  res.sendFile(path.join(__dirname, '..', 'public', 'checkout.html'));
});

app.get('/pg/checkout/session/:sessionId', (req, res) => {
  const orderId = sessions.get(req.params.sessionId);
  const order = orderId ? orders.get(orderId) : undefined;
  if (!order) return fail(res, 404, 'INVALID_SESSION', 'This payment session does not exist');
  if (Date.now() > order.expiresAt) return fail(res, 410, 'SESSION_EXPIRED', 'This payment session has expired');
  if (order.status === 'PAID') return fail(res, 409, 'ALREADY_PAID', 'This order is already paid');

  const merchant = merchantByMid(order.mid)!;
  res.json({
    orderId: order.orderId,
    amount: order.amountPaise / 100,
    currency: order.currency,
    merchantName: merchant.name,
    customer: order.customer,
    note: order.note,
    returnUrl: order.returnUrl,
    allowedOrigins: merchant.allowedOrigins,
    expiresAt: new Date(order.expiresAt).toISOString(),
  });
});

app.post('/pg/checkout/pay', async (req, res) => {
  const { session, method, instrument } = req.body ?? {};
  const orderId = sessions.get(String(session ?? ''));
  const order = orderId ? orders.get(orderId) : undefined;
  if (!order) return fail(res, 404, 'INVALID_SESSION', 'This payment session does not exist');
  if (Date.now() > order.expiresAt) return fail(res, 410, 'SESSION_EXPIRED', 'This payment session has expired');
  if (order.status === 'PAID') return fail(res, 409, 'ALREADY_PAID', 'This order is already paid');

  const outcome = outcomeFor(String(method), String(instrument ?? ''));
  const payment: Payment = {
    paymentId: ref('pay'),
    orderId: order.orderId,
    mid: order.mid,
    amountPaise: order.amountPaise,
    status: outcome.status,
    method: String(method),
    message: outcome.message,
    errorCode: outcome.errorCode,
    bankReference: outcome.status === 'SUCCESS' ? String(Math.floor(1e11 + Math.random() * 9e11)) : undefined,
    createdAt: Date.now(),
    resolveAt: outcome.resolveInMs ? Date.now() + outcome.resolveInMs : undefined,
    resolveTo: outcome.resolveTo,
  };
  payments.set(payment.paymentId, payment);

  if (payment.status === 'SUCCESS') await markPaid(order, payment);
  else if (payment.status === 'FAILED') await notify(order, payment, 'payment.failed');

  res.json(toPaymentJson(payment));
});

/** The checkout page polls this while a UPI collect is pending. */
app.get('/pg/checkout/payment/:paymentId', (req, res) => {
  const payment = payments.get(req.params.paymentId);
  if (!payment) return fail(res, 404, 'PAYMENT_NOT_FOUND', 'No such payment');
  settlePending(payment.orderId);
  res.json(toPaymentJson(payments.get(payment.paymentId)!));
});

app.get('/health', (_req, res) => res.json({ ok: true, orders: orders.size, payments: payments.size }));

/* --------------------------------------------------------------- helpers */

/** Resolve any pending payment whose simulated deadline has passed.
 *  A real gateway does this from a bank callback plus a status-polling sweeper. */
function settlePending(orderId: string): void {
  for (const p of payments.values()) {
    if (p.orderId !== orderId || p.status !== 'PENDING' || !p.resolveAt) continue;
    if (Date.now() < p.resolveAt) continue;

    p.status = p.resolveTo ?? 'SUCCESS';
    if (p.status === 'SUCCESS') {
      p.message = 'Payment successful';
      p.bankReference = String(Math.floor(1e11 + Math.random() * 9e11));
      const order = orders.get(orderId);
      if (order) void markPaid(order, p);
    } else {
      p.message = 'You did not approve the request in time';
      p.errorCode = 'UPI_TIMEOUT';
    }
  }
}

async function markPaid(order: Order, payment: Payment): Promise<void> {
  order.status = 'PAID';
  await notify(order, payment, 'payment.success');
}

async function notify(order: Order, payment: Payment, type: string): Promise<void> {
  const merchant = merchantByMid(order.mid);
  if (!merchant) return;
  await dispatch(merchant, {
    type,
    eventTime: new Date().toISOString(),
    data: { order: toOrderJson(order), payment: toPaymentJson(payment) },
  });
}

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`Payment gateway on http://localhost:${port}`);
  console.log(`  API      http://localhost:${port}/pg/orders`);
  console.log(`  Checkout http://localhost:${port}/checkout?session=...`);
});
