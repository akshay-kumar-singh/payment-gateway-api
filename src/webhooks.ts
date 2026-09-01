/**
 * Outbound webhooks.
 *
 * The webhook is the only message a merchant should build business logic on: it arrives
 * whether or not the customer's browser survived the payment. It is signed so the
 * merchant can prove it came from us, and timestamped so an attacker cannot replay
 * yesterday's "payment succeeded".
 */
import { createHmac } from 'node:crypto';
import type { Merchant } from './store.js';

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('base64');
}

export async function dispatch(merchant: Merchant, event: unknown): Promise<void> {
  if (!merchant.webhookUrl) return;

  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Real delivery is a durable queue with exponential backoff over hours. This is a
  // best-effort fire-and-forget: enough to prove the signature flow end to end.
  try {
    await fetch(merchant.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': sign(merchant.clientSecret, timestamp, body),
        'x-webhook-timestamp': timestamp,
        'x-webhook-version': '2026-01-01',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // A real gateway would retry. Swallowing here keeps the payment path unaffected
    // by a merchant's endpoint being down.
  }
}
