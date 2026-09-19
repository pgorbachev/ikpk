import { it } from 'vitest';
import { activePayment, deployCheck } from './helpers';

it('read-only OPTIONS validates the actual endpoint and cross-origin response where applicable', () => {
  const payment = activePayment();
  if (new URL(payment.endpoint).origin !== new URL(payment.origin).origin) deployCheck('payment_cors_allows', payment.endpoint, payment.origin);
  else deployCheck('payment_endpoint_reachable', payment.endpoint);
});
