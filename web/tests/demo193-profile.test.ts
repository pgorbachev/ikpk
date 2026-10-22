import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
      DEMO_SITE_URL: 'https://194.226.99.10',
    });
    expect(resolved).not.toHaveProperty('DEMO_OUTPUT');
    expect(resolved).not.toHaveProperty('CHAT_LOADER_FALLBACK');
    expect(resolved).not.toHaveProperty('CHAT_LOADER_PROFILE');
  });

  it('rejects an unapproved loader and an unknown chat profile', async () => {
    const { resolveDemo193Environment } = await import('../scripts/demo193-profile.mjs');
    expect(() => resolveDemo193Environment({
      CHAT_LOADER_PROFILE: 'staging194-static-main',
      CHAT_LOADER_SRC: 'https://attacker.example/loader.js',
    })).toThrow('staging194 static-main requires the owner-approved chat loader');
    expect(() => resolveDemo193Environment({
      CHAT_LOADER_PROFILE: 'some-other-stand',
      CHAT_LOADER_SRC: 'https://attacker.example/loader.js',
    })).toThrow('CHAT_LOADER_PROFILE must be the approved staging194 static-main profile');
  });

  it('carries only the owner-approved staging194 static-main chat through the actual build entrypoint', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const temporary = mkdtempSync(pathJoin(tmpdir(), 'demo193-profile-build-'));
    temporaryDirectories.push(temporary);
    const bin = pathJoin(temporary, 'bin');
    mkdirSync(bin);
    const capture = pathJoin(temporary, 'capture.txt');
    for (const command of ['astro', 'pagefind']) {
      const executable = pathJoin(bin, command);
      writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$CHAT_LOADER_SRC" "$CHAT_LOADER_PROFILE" >> "$BUILD_CAPTURE"\n');
      chmodSync(executable, 0o755);
    }
    const result = spawnSync(process.execPath, [pathJoin(WEB, 'scripts/build-demo193.mjs')], {
      cwd: WEB,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BUILD_CAPTURE: capture,
        CHAT_LOADER_PROFILE: 'staging194-static-main',
        CHAT_LOADER_SRC: 'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(read(capture, 'utf8').trim().split('\n')).toEqual([
      'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js',
      'staging194-static-main',
      'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js',
      'staging194-static-main',
    ]);
  });

  it('provides a dedicated command and leaves the established demo and production commands intact', () => {
    const scripts = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')).scripts;
    expect(scripts['build:demo193'], 'there is no explicit demo193 build entrypoint').toBeTypeOf('string');
    expect(scripts['build:demo193']).toBe('node scripts/build-demo193.mjs');
    const runner = readFileSync(join(WEB, 'scripts/build-demo193.mjs'), 'utf8');
    expect(runner).toContain("import { resolveDemo193Environment } from './demo193-profile.mjs';");
    expect(runner).toContain("['astro', ['build', '--outDir', 'dist-demo193']]");
    expect(runner).toContain("['pagefind', ['--site', 'dist-demo193']]");
    expect(scripts['build:demo']).toContain('DEMO_OUTPUT=1');
    expect(scripts.build).toBe('astro build && pagefind --site dist');
  });

});
