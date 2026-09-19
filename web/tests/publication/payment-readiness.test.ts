import { it } from 'vitest';
import { activePayment, deployCheck, tree } from './helpers';

it('active artifact declares exactly the trusted payment endpoint and role', () => {
  const payment = activePayment();
  deployCheck('payment_endpoint_matches', tree(), payment.endpoint, payment.role);
});
it('read-only readiness reports the trusted service mode and shop', () => {
  const payment = activePayment();
  deployCheck('payment_readiness_matches', payment.ready, payment.mode, payment.shop);
});
