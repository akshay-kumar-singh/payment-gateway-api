/**
 * In-memory store.
 *
 * A real gateway puts all of this in Postgres with a double-entry ledger beside it.
 * This is a development gateway: restart the process and everything is gone. That is
 * fine for building and testing SDKs, and it keeps the repo deployable with no database.
 */
import { randomUUID, randomBytes } from 'node:crypto';

export interface Merchant {
  mid: string;
  name: string;
  clientId: string;
  clientSecret: string;
  /** Origins allowed to open a checkout for this merchant. */
  allowedOrigins: string[];
  webhookUrl?: string;
}

export interface Order {
  orderId: string;
  mid: string;
  amountPaise: number;
  currency: string;
  status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED';
  paymentSessionId: string;
  customer: { customerId: string; customerPhone: string; customerEmail?: string; customerName?: string };
  returnUrl?: string;
  note?: string;
  tags?: Record<string, string>;
  createdAt: number;
  expiresAt: number;
}

export interface Payment {
  paymentId: string;
  orderId: string;
  mid: string;
  amountPaise: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  method: string;
  message: string;
  errorCode?: string;
  bankReference?: string;
  createdAt: number;
  /** Set for pending UPI: when the simulated approval lands. */
  resolveAt?: number;
  resolveTo?: 'SUCCESS' | 'FAILED';
}

export interface Refund {
  refundId: string;
  orderId: string;
  paymentId: string;
  amountPaise: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  note?: string;
  createdAt: number;
}

/** One seeded test merchant, so the SDKs work the moment the server starts. */
export const MERCHANTS: Merchant[] = [
  {
    mid: 'mrc_demo',
    name: 'Nimbus Store',
    clientId: 'TEST_clientid_demo',
    clientSecret: 'pgsk_TEST_secret_demo_00000000',
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    // Where we POST signed events. Set MERCHANT_WEBHOOK_URL to point elsewhere.
    webhookUrl: process.env.MERCHANT_WEBHOOK_URL ?? 'http://localhost:4000/webhook',
  },
];

export const orders = new Map<string, Order>();
export const sessions = new Map<string, string>(); // paymentSessionId -> orderId
export const payments = new Map<string, Payment>();
export const refunds = new Map<string, Refund>();
/** Idempotency: same key returns the same order instead of creating a second one. */
export const idempotency = new Map<string, string>();

export const ORDER_TTL_MS = 15 * 60 * 1000;

export const findMerchant = (clientId: string, clientSecret: string): Merchant | undefined =>
  MERCHANTS.find((m) => m.clientId === clientId && m.clientSecret === clientSecret);

export const merchantByMid = (mid: string): Merchant | undefined =>
  MERCHANTS.find((m) => m.mid === mid);

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789';
export function ref(prefix: string, len = 18): string {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return `${prefix}_${out}`;
}

export const newSessionId = (): string =>
  `session_${randomUUID().replace(/-/g, '')}${randomBytes(8).toString('hex')}`;
