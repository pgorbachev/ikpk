#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicationStateStore } from './lib/publication-state-store.ts';

const [action, fingerprint, expectedRaw, operationId] = process.argv.slice(2);
if (!['preflight', 'read', 'record'].includes(action ?? '') ||
    (action !== 'preflight' && !/^sha256:[a-f0-9]{64}$/.test(fingerprint ?? '')) ||
    (action === 'read' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedRaw ?? '')) ||
    (action === 'record' && (!/^[1-9][0-9]*$/.test(expectedRaw ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId ?? '')))) {
  throw new Error('invalid paired restore provenance arguments');
}
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (!token) throw new Error('canonical provenance authentication unavailable');
const scratch = mkdtempSync(join(tmpdir(), 'ikpk-paired-restore-state-'));
try {
  const remote = 'https://github.com/pgorbachev/ikpk.git';
  const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
  const store = createPublicationStateStore({ remote, workDir: join(scratch, 'state'), gitEnv });
  if (action === 'preflight') {
    const state = await store.readHistory(true);
    process.stdout.write(`${JSON.stringify({ preflight: true, lineage: state.lineage })}\n`);
  } else if (action === 'read') {
    const state = await store.read(fingerprint);
    const latest = state.entries.at(-1)!;
    const retry = latest.marker === 'restore' && latest.operationId === expectedRaw;
    if (!retry && (state.observation.requiresConfirmation || state.observation.revision === null ||
        state.observation.revision !== state.observation.highWaterMark ||
        state.observation.observedEntry !== state.observation.highWaterMark)) {
      throw new Error('restored backup does not match accepted current provenance');
    }
    process.stdout.write(`${JSON.stringify({ fingerprint, observedEntry: state.observation.observedEntry,
      revision: state.observation.revision, highWaterMark: state.observation.highWaterMark,
      latestEntry: latest.number, latestFingerprint: latest.fingerprint,
      latestMarker: latest.marker, latestOperationId: latest.operationId, retry })}\n`);
  } else {
    const result = await store.recordRestore({ expectedObservedEntry: Number(expectedRaw), fingerprint, operationId });
    process.stdout.write(`${JSON.stringify({ fingerprint, operationId, entry: result.entry.number, changed: result.changed })}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
