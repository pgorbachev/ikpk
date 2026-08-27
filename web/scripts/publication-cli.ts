#!/usr/bin/env node
/**
 * CLI врезки гейта публикации: вызывает модули publish-gate / provenance-ledger /
 * published-state / release-declaration. Имена подкоманд и импортов — предмет
 * pipeline-тестов (cms-publication-pipeline).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparePublishedState } from './lib/published-state.ts';
import {
  chooseManualPublication,
  classifyEventDrivenPublication,
  classifySnapshotForPublication,
  SNAPSHOT_RETENTION_DAYS,
  type VerifiedPair,
} from './lib/publish-gate.ts';
import { createLedger } from './lib/provenance-ledger.ts';
import { fetchReleaseDeclaration, writeReleaseDeclaration } from './lib/release-declaration.ts';
import { readVerifiedPairs, upsertVerifiedPair, writeVerifiedPairs, mergeVerifiedPairs } from './lib/verified-pairs.ts';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`::error::нужен --${name}`);
    process.exit(2);
  }
  return value;
}

function loadSnapshot(dir: string): {
  snapshotId: string;
  fingerprint: string;
  referenceDate: string;
  pinned?: boolean;
  provenance?: { observedEntry: number; revision: number | null; highWaterMark: number };
} {
  const path = join(dir, 'snapshot.json');
  if (!existsSync(path)) throw new Error(`нет ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8')) as ReturnType<typeof loadSnapshot>;
}

async function cmdReconcile(): Promise<void> {
  const origin = requireArg('origin');
  const snapshotDir = requireArg('snapshot-dir');
  const commit = requireArg('commit');
  const pairsDir = arg('pairs-dir');
  const snap = loadSnapshot(snapshotDir);
  const expected = { commit, snapshotId: snap.snapshotId };
  const { observed, httpStatus } = await fetchReleaseDeclaration(origin);
  const result = comparePublishedState({ expected, observed });

  if (result.status === 'match') {
    console.log('reconcile: match', expected);
    return;
  }

  const pairs = pairsDir ? readVerifiedPairs(pairsDir) : [];
  // Первый прогон: на раздаче ещё нет /release.json и нет истории пар — не вакуумный
  // «расхождений нет», а явный soft-start до первой выкладки с объявлением.
  if (result.status === 'unreadable' && pairs.length === 0 && httpStatus === 404) {
    console.warn(
      '::warning::reconcile: /release.json ещё нет (первая публикация) — сверка отложена до выкладки',
    );
    return;
  }

  console.error(
    `::error::reconcile: ${result.status}` +
      (result.differing ? ` differing=${result.differing.join(',')}` : '') +
      ` expected=${JSON.stringify(expected)} observed=${JSON.stringify(observed)} http=${httpStatus}`,
  );
  process.exit(1);
}

async function cmdGateSnapshot(): Promise<void> {
  const ledgerDir = requireArg('ledger-dir');
  const snapshotDir = requireArg('snapshot-dir');
  const confirmedBy = arg('confirmed-by');
  const snap = loadSnapshot(snapshotDir);
  const ledger = createLedger({
    dir: ledgerDir,
    hasPublicationHistory: existsSync(join(ledgerDir, 'high-water-mark')),
  });
  const fingerprint = snap.fingerprint;
  if (!fingerprint) throw new Error('у снимка нет fingerprint');
  const observation = await ledger.observe({ fingerprint });
  const entries = await ledger.entries();
  // Фикстурный путь до наполнения CMS: журнала ещё нет — bootstrap, не require-confirmation
  // на пустом revision. Живые события потом заполнят orphan-ветку.
  if (entries.length === 0 && snap.pinned) {
    console.log(
      JSON.stringify({
        decision: { action: 'publish', reason: 'pinned-bootstrap' },
        observation,
      }),
    );
    return;
  }
  const latest = entries.at(-1)?.number ?? 0;
  const decision = classifySnapshotForPublication({
    observedEntry: snap.provenance?.observedEntry ?? observation.observedEntry,
    latestEntry: latest,
    revision: snap.provenance?.revision ?? observation.revision,
    highWaterMark: snap.provenance?.highWaterMark ?? observation.highWaterMark,
    confirmedBy,
  });
  console.log(JSON.stringify({ decision, observation }));
  if (decision.action === 'cancel-stale' || decision.action === 'require-confirmation') {
    console.error(`::error::publication gate: ${decision.action}`);
    process.exit(1);
  }
  if (decision.action !== 'publish') {
    console.error(`::error::publication gate: ${decision.action} ${decision.reason ?? ''}`);
    process.exit(1);
  }
}

async function cmdRecordPair(): Promise<void> {
  const pairsDir = requireArg('pairs-dir');
  const commit = requireArg('commit');
  const snapshotDir = requireArg('snapshot-dir');
  const revision = Number(requireArg('revision'));
  const snap = loadSnapshot(snapshotDir);
  const pair: VerifiedPair = {
    commit,
    snapshotId: snap.snapshotId,
    revision,
    referenceDate: snap.referenceDate,
    capturedAt: new Date().toISOString(),
    testRunConclusion: 'success',
  };
  const next = upsertVerifiedPair(readVerifiedPairs(pairsDir), pair);
  writeVerifiedPairs(pairsDir, next);
  console.log('recorded pair', pair.snapshotId);
}

/** Слить локальный индекс с файлом с origin — без регресса более новых пар. */
async function cmdMergePairs(): Promise<void> {
  const pairsDir = requireArg('pairs-dir');
  const withPath = requireArg('with');
  const remoteRaw = JSON.parse(readFileSync(withPath, 'utf-8')) as VerifiedPair[];
  if (!Array.isArray(remoteRaw)) throw new Error(`${withPath}: ожидался массив`);
  const result = mergeVerifiedPairs(readVerifiedPairs(pairsDir), remoteRaw);
  writeVerifiedPairs(pairsDir, result);
  console.log('merged pairs', result.length);
}

async function cmdWriteRelease(): Promise<void> {
  const outDir = requireArg('out-dir');
  const commit = requireArg('commit');
  const snapshotDir = requireArg('snapshot-dir');
  const snap = loadSnapshot(snapshotDir);
  const path = writeReleaseDeclaration(outDir, { commit, snapshotId: snap.snapshotId });
  console.log('wrote', path);
}

async function cmdChooseManual(): Promise<void> {
  const pairsDir = requireArg('pairs-dir');
  const headCommit = requireArg('head-commit');
  const actor = requireArg('actor');
  const ledgerDir = arg('ledger-dir');
  const rollbackId = arg('rollback-snapshot-id');
  const rollbackConfirmed = arg('rollback-confirmed') === 'true';
  const pairs = readVerifiedPairs(pairsDir);
  let highWaterMark = 0;
  if (ledgerDir) {
    const ledger = createLedger({ dir: ledgerDir, hasPublicationHistory: true });
    highWaterMark = await ledger.highWaterMark();
  }
  const decision = chooseManualPublication({
    headCommit,
    verifiedPairs: pairs,
    highWaterMark,
    now: new Date().toISOString(),
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    actor,
    rollback: rollbackId
      ? {
          snapshotId: rollbackId,
          confirmed: rollbackConfirmed,
          reasonHeadNotPublished: arg('rollback-reason') ?? 'confirmed rollback',
        }
      : undefined,
  });
  console.log(JSON.stringify(decision));
  if (decision.action !== 'publish' || !decision.pair) {
    console.error(`::error::manual publication refused: ${decision.reason ?? decision.action}`);
    process.exit(1);
  }
  // Для деплоя: куда указать CONTENT_SNAPSHOT / какой snapshotId брать из артефактов.
  console.log(`pair_commit=${decision.pair.commit}`);
  console.log(`pair_snapshot=${decision.pair.snapshotId}`);
}

async function cmdEventGate(): Promise<void> {
  const decision = classifyEventDrivenPublication({
    verifiedCommit: requireArg('verified-commit'),
    headAtLastCheck: requireArg('head'),
    testRunConclusion: requireArg('conclusion') as VerifiedPair['testRunConclusion'],
  });
  console.log(JSON.stringify(decision));
  if (decision.action !== 'publish') {
    console.error(`::error::event gate: ${decision.action} ${decision.reason ?? ''}`);
    process.exit(1);
  }
}

const cmd = process.argv[2];
const runners: Record<string, () => Promise<void>> = {
  reconcile: cmdReconcile,
  'gate-snapshot': cmdGateSnapshot,
  'record-pair': cmdRecordPair,
  'merge-pairs': cmdMergePairs,
  'write-release': cmdWriteRelease,
  'choose-manual': cmdChooseManual,
  'event-gate': cmdEventGate,
};

if (!cmd || !(cmd in runners)) {
  console.error(
    `usage: publication-cli.ts <${Object.keys(runners).join('|')}> …`,
  );
  process.exit(2);
}

runners[cmd]().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
