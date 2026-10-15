import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('demo193 deployed build profile', () => {
  it('resolves hostile inherited build flags to a bounded stand profile', async () => {
    const { resolveDemo193Environment } = await import('../scripts/demo193-profile.mjs');
    const resolved = resolveDemo193Environment({
      PATH: '/safe/bin',
      DEMO_OUTPUT: '1',
      PAYMENT_ROLE: 'stand',
      DEMO_FORMS: 'customer.bitrix24site.ru',
      CHAT_LOADER_SRC: 'https://production.example/loader.js',
      CHAT_OFFLINE_MESSAGE: 'production portal',
      CHAT_LOADER_FALLBACK: 'synthetic',
      DEMO_SITE_URL: 'https://attacker.example',
    });

    expect(resolved).toMatchObject({
      PATH: '/safe/bin',
      DEMO_PROFILE: 'demo193',
      DEPLOY_MODE: 'stand',
      PAYMENT_ROLE: 'ci',
      DEMO_FORMS: 'stub',
      CHAT_LOADER_SRC: 'none',
      CHAT_OFFLINE_MESSAGE: 'absent',
      DEMO_SITE_URL: 'https://193.124.115.99',
    });
    expect(resolved).not.toHaveProperty('DEMO_OUTPUT');
    expect(resolved).not.toHaveProperty('CHAT_LOADER_FALLBACK');
  });

  it('provides a dedicated command and leaves the established demo and production commands intact', () => {
    const scripts = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')).scripts;
    expect(scripts['build:demo193'], 'there is no explicit demo193 build entrypoint').toBeTypeOf('string');
    expect(scripts['build:demo193']).toContain('demo193-profile.mjs');
    expect(scripts['build:demo193']).toContain('dist-demo193');
    expect(scripts['build:demo']).toContain('DEMO_OUTPUT=1');
    expect(scripts.build).toBe('astro build && pagefind --site dist');
  });

});
