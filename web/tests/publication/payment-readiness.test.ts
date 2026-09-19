import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { activePayment, deployCheck, required, tree } from './helpers';

it('active artifact declares exactly the trusted payment endpoint and role', () => {
  const payment = activePayment();
  deployCheck('payment_endpoint_matches', tree(), payment.endpoint, payment.role);
});
it('read-only readiness reports the trusted service mode and shop', () => {
  const payment = activePayment();
  let response;
  try { response = JSON.parse(readFileSync(required('PUBLICATION_PAYMENT_READY_RESPONSE_FILE'), 'utf8')); }
  catch { throw new Error('destination readiness response unavailable'); }
  const body = response?.body;
  // Assert only a boolean: malformed remote bodies must never appear in reporter output.
  const valid = response?.status === 200 && typeof response.contentType === 'string' &&
    /^application\/json(?:\s*;|$)/i.test(response.contentType) && body !== null && typeof body === 'object' && !Array.isArray(body) &&
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['mode', 'shopId', 'status']) &&
    body.status === 'ready' && body.mode === payment.mode && body.shopId === payment.shop;
  expect(valid, 'destination readiness did not confirm the expected service identity').toBe(true);
});
