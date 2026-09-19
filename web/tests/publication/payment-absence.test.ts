import { it, expect } from 'vitest';
import { deployCheck, required, tree } from './helpers';

it('ci explicitly has neither a payment form nor an endpoint, without contacting an API', () => {
  expect(required('PAYMENT_ROLE')).toBe('ci');
  expect(Object.keys(process.env).filter((key) => key.startsWith('PUBLICATION_PAYMENT_'))).toEqual([]);
  deployCheck('payment_endpoint_matches', tree(), '', 'ci');
});
