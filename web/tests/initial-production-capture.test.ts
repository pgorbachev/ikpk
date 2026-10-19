import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertCaptureSnapshotContract } from '../scripts/lib/capture-snapshot-contract.ts';
import { assertSnapshotContract } from '../scripts/lib/content-contract.ts';
import type { Snapshot } from '../scripts/lib/content-snapshot.ts';

const snapshot = (): Snapshot => ({
  content: { types: {}, media: [] },
  referenceDate: '2026-10-19',
  origin: { kind: 'server-db', sourceId: 'initial-prod-server-db', capturedAt: '2026-10-19T10:00:00.000Z' },
  sourcePolicy: 'initial-production',
  sourceAge: 'source-bound',
  captureProof: {
    version: 1,
    method: 'quiesced-sqlite-backup',
    targetHost: '89.111.184.196',
    siteUrl: 'https://ikpk.su',
    sourceSha: 'a'.repeat(40),
    runId: 12345,
    attempt: 2,
    captureId: 'initial-prod-20261019-A-01',
    schemaDigest: 'b'.repeat(64),
    databaseDigest: 'c'.repeat(64),
    mediaManifestDigest: 'd'.repeat(64),
    bundleDigest: 'e'.repeat(64),
  },
});

describe('initial production capture proof', () => {
  it('accepts only the explicit source-bound capture path', () => {
    expect(() => assertCaptureSnapshotContract(snapshot(), undefined, 'initial-prod')).not.toThrow();
  });

  it('keeps ordinary snapshot readers strict about the one-off proof', () => {
    expect(() => assertSnapshotContract(snapshot())).toThrow(/staging193 publication snapshot/);
  });

  it('rejects a proof for another operation, target, or source run', () => {
    for (const changed of [
      { ...snapshot(), captureProof: { ...snapshot().captureProof, captureId: 'another-op' } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, targetHost: '194.226.99.10' } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, runId: 0 } },
      { ...snapshot(), captureProof: { ...snapshot().captureProof, attempt: 0 } },
    ]) {
      expect(() => assertCaptureSnapshotContract(changed as Snapshot, undefined, 'initial-prod')).toThrow(/source-bound server-DB proof/);
    }
  });
});

describe('initial production Astro profile', () => {
  const webRoot = resolve(import.meta.dirname, '..');
  const configImport = "await import('./astro.config.mjs')";
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    INITIAL_PROD_PROFILE: '1',
    DEPLOY_MODE: 'prod',
    PAYMENT_ROLE: 'prod',
    PAYMENT_ENDPOINT_PROD: 'https://ikpk.su/api',
    CONTENT_SNAPSHOT_DIR: resolve(webRoot, '../fixtures/content-snapshot'),
  };
  for (const key of ['DEMO_OUTPUT', 'DEMO_PROFILE', 'DEMO_FORMS', 'CHAT_LOADER_SRC',
    'CHAT_LOADER_FALLBACK', 'CHAT_OFFLINE_MESSAGE'] as const) {
    delete baseEnvironment[key];
  }

  const importConfig = (overrides: Record<string, string | undefined>) => {
    const env = { ...baseEnvironment };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawnSync(process.execPath, ['--input-type=module', '-e', configImport], {
      cwd: webRoot,
      env,
      encoding: 'utf8',
    });
  };

  it('imports with the exact production loader URL', () => {
    const result = importConfig({
      CHAT_LOADER_SRC: 'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js',
      CHAT_OFFLINE_MESSAGE: undefined,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses an unspecified loader and demo or synthetic configuration', () => {
    for (const overrides of [
      { CHAT_LOADER_SRC: undefined },
      { CHAT_LOADER_SRC: 'none' },
      { CHAT_LOADER_SRC: 'https://cdn.example.invalid/another-loader.js' },
      { CHAT_LOADER_SRC: 'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js', DEMO_OUTPUT: '1' },
      { CHAT_LOADER_SRC: 'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js', DEMO_FORMS: 'stub' },
      { CHAT_LOADER_SRC: 'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js', CHAT_OFFLINE_MESSAGE: 'absent' },
    ]) {
      const result = importConfig(overrides);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(/initial production profile/);
    }
  });
});
