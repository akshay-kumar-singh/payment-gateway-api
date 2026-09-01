/**
 * Deterministic test instruments.
 *
 * Every gateway ships these, and merchants integrate against them. The rule: a merchant
 * must be able to reproduce ANY failure on demand, or they cannot build their own error
 * handling — and they will blame you in production.
 */
export interface Outcome {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  message: string;
  errorCode?: string;
  /** For PENDING: milliseconds until it resolves, and what it resolves to. */
  resolveInMs?: number;
  resolveTo?: 'SUCCESS' | 'FAILED';
}

export const TEST_CARDS: Record<string, Outcome> = {
  '4111111111111111': { status: 'SUCCESS', message: 'Payment successful' },
  '5555555555554444': { status: 'SUCCESS', message: 'Payment successful' },
  '6011000000000004': { status: 'SUCCESS', message: 'Payment successful' },
  '4000000000000002': { status: 'FAILED', message: 'Your bank declined this card', errorCode: 'CARD_DECLINED' },
  '4000000000009995': { status: 'FAILED', message: 'Not enough balance in this account', errorCode: 'INSUFFICIENT_FUNDS' },
  '4000000000000069': { status: 'FAILED', message: 'This card has expired', errorCode: 'EXPIRED_CARD' },
  '4000000000000127': { status: 'FAILED', message: 'The CVV does not match this card', errorCode: 'INCORRECT_CVV' },
  '4000000000000119': { status: 'FAILED', message: 'The payment took too long', errorCode: 'GATEWAY_TIMEOUT' },
};

export const TEST_VPAS: Record<string, Outcome> = {
  'success@pgtest': { status: 'PENDING', message: 'Waiting for you to approve in your UPI app', resolveInMs: 5000, resolveTo: 'SUCCESS' },
  'failure@pgtest': { status: 'FAILED', message: 'You declined the payment', errorCode: 'UPI_DECLINED' },
  'timeout@pgtest': { status: 'PENDING', message: 'Waiting for you to approve in your UPI app', resolveInMs: 90_000, resolveTo: 'FAILED' },
  'invalid@pgtest': { status: 'FAILED', message: 'That UPI ID does not exist', errorCode: 'UPI_INVALID_VPA' },
};

/** Banks seeded as down, so merchants can test the unavailable path. */
export const DOWN_BANKS = new Set(['CNRB', 'MOBIKWIK']);

export function outcomeFor(method: string, instrument: string): Outcome {
  if (method === 'card' || method === 'emi') {
    const digits = instrument.replace(/\D/g, '');
    return TEST_CARDS[digits] ?? { status: 'SUCCESS', message: 'Payment successful' };
  }
  if (method === 'upi') {
    const known = TEST_VPAS[instrument.trim().toLowerCase()];
    if (known) return known;
    // Unknown VPA: behaves like a real collect request the customer approves.
    return { status: 'PENDING', message: 'Waiting for you to approve in your UPI app', resolveInMs: 5000, resolveTo: 'SUCCESS' };
  }
  if (DOWN_BANKS.has(instrument.toUpperCase())) {
    return { status: 'FAILED', message: 'Your bank is not responding right now', errorCode: 'BANK_UNAVAILABLE' };
  }
  return { status: 'SUCCESS', message: 'Payment successful' };
}
