import { describe, expect, it } from 'vitest';
import { registrationHref } from '../src/lib/forms';

const rejected = [
  ['javascript scheme', 'javascript:example'],
  ['same scheme with leading space and different case', ' JAVASCRIPT:example'],
  ['vbscript scheme', 'vbscript:example'],
  ['data scheme', 'data:text/plain,example'],
  ['file scheme', 'file:example'],
  ['protocol-relative host', '//example.com/path'],
] as const;

const kept = [
  ['absolute http URL', 'http://example.com/signup'],
  ['absolute https URL', 'https://example.com/signup'],
  ['single-slash path', '/signup'],
] as const;

async function loadSafeHref(): Promise<(value: string) => string> {
  const mod = await import('../src/lib/safe-href');
  return mod.safeHref;
}

describe('reject disallowed URL schemes in registration and promo links', () => {
  it.each(rejected)('safeHref rejects a %s', async (_label, value) => {
    const safeHref = await loadSafeHref();
    expect(safeHref(value)).toBe('');
  });

  it.each(kept)('safeHref keeps %s', async (_label, value) => {
    const safeHref = await loadSafeHref();
    expect(safeHref(value)).toBe(value);
  });

  it.each(rejected)('registrationHref rejects a %s', (_label, value) => {
    expect(registrationHref(value)).toBe('');
  });

  it.each(kept)('registrationHref keeps %s', (_label, value) => {
    expect(registrationHref(value)).toBe(value);
  });
});
