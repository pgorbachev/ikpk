import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLedger } from '../../scripts/lib/provenance-ledger.ts';
import { contentFingerprint, snapshotId, type Snapshot } from '../../scripts/lib/content-snapshot.ts';
import type { PublicationCheckContext } from '../../scripts/lib/publication-checks.ts';
import type {
  PublicationAdapterOptions, PublicationAdapterRuntime, PublicationCommand,
} from '../../scripts/lib/publication-check-adapters.ts';

export const CANARY = 'adapter-test-secret-canary';
export const STAGES = ['snapshot', 'build', 'destination', 'payment-absence', 'payment-readiness', 'payment-preflight'] as const;
export type Stage = typeof STAGES[number];
export function vitestReport(count = 3) {
  return {
    success: true, numTotalTests: count, numPassedTests: count, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0,
    testResults: [{ status: 'passed', assertionResults: Array.from({ length: count }, (_, i) => ({
      fullName: `actual assertion ${i}`, status: 'passed',
    })) }],
  };
}
export function browserReport() {
  return {
    errors: [], stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ title: 'live publication smoke', specs: [
      { title: 'main/navigation', ok: true, tests: ['desktop', 'mobile'].map((projectName) => ({
        projectName, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0 }],
      })) },
      { title: 'schedule/registration', ok: true, tests: ['desktop', 'mobile'].map((projectName) => ({
        projectName, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0 }],
      })) },
    ] }],
  };
}

export async function adapterFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-publication-adapters-'));
  const webRoot = join(temp, 'web');
  const snapshotDir = join(temp, 'captured');
  const reportsDir = join(temp, 'reports');
  const ledgerDir = join(temp, 'ledger');
  for (const dir of [webRoot, snapshotDir, reportsDir, join(webRoot, 'dist'), join(temp, 'home')]) mkdirSync(dir, { recursive: true });
  const content = {
    types: {
      institutes: [{ slug: 'institute', legacy_id: 'institute' }],
      course_groups: [{ slug: 'program', legacy_id: 'program', institute_legacy_id: 'institute' }],
      seminars: [{ slug: 'seminar', course_group_legacy_id: 'program' }],
      articles: [{ slug: 'article', title: 'Article', body: '<p>Live</p>', page_title: 'Article', page_description: 'Description', image: '/media/image.svg' }],
      teachers: [{ slug: 'teacher', institute_legacy_id: 'institute' }],
      schedule_entries: [],
    },
    media: [],
  };
  const fingerprint = contentFingerprint(content);
  const snapshot: Snapshot = {
    content, fingerprint, referenceDate: '2026-09-19',
    snapshotId: snapshotId({ fingerprint, referenceDate: '2026-09-19' }),
    origin: { kind: 'live', url: 'https://cms.test.invalid', capturedAt: '2026-09-19T12:00:00Z' },
  };
  const ledger = createLedger({ dir: ledgerDir });
  await ledger.recordEvent({ fingerprint, marker: 'edit' });
  snapshot.provenance = { observedEntry: 1, revision: 1, highWaterMark: 1 };
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
  const options: PublicationAdapterOptions = {
    webRoot, snapshotDir, reportsDir, ledgerDir,
    captureEnv: { PATH: process.env.PATH, CMS_URL: 'https://cms.test.invalid', CMS_TOKEN: CANARY },
    payment: { endpoint: 'https://payments.test.invalid/api', readinessUrl: 'https://payments.test.invalid/readyz', mode: 'test', shopId: 'shop-42', siteOrigin: 'https://site.test.invalid' },
  };
  const context: PublicationCheckContext = {
    commit: 'a'.repeat(40), destinationId: 'stand', deployMode: 'stand', paymentRole: 'ci',
    treeDir: join(webRoot, 'dist'), reportPath: join(temp, 'publication.json'),
    snapshotDir, snapshotId: snapshot.snapshotId!,
    env: { PATH: process.env.PATH, HOME: join(temp, 'home'), TMPDIR: join(temp, 'home'),
      CONTENT_SNAPSHOT_DIR: snapshotDir, DEPLOY_MODE: 'stand', PAYMENT_ROLE: 'ci', DEMO_FORMS: 'stub' },
  };
  const commands: PublicationCommand[] = [];
  const previews: { treeDir: string; env: Record<string, string | undefined> }[] = [];
  const state = {
    exitCode: 0 as number | null, signal: null as string | null, omitReport: false,
    rawReport: undefined as string | undefined, closed: 0,
    reports: Object.fromEntries(STAGES.map((stage) => [stage, vitestReport()])) as Record<Stage, ReturnType<typeof vitestReport>>,
    browser: browserReport(),
  };
  const reportPath = (stage: Stage | 'browser') => join(reportsDir, `${stage}.json`);
  const runtime: PublicationAdapterRuntime = Object.assign({ paymentReadiness: async () => ({ status: 200, contentType: 'application/json', body: { status: 'ready', mode: options.payment!.mode, shopId: options.payment!.shopId } }) }, {
    async run(command) {
      commands.push(structuredClone(command));
      if (command.args.some((arg) => arg.endsWith('capture-content-snapshot.ts'))) {
        mkdirSync(snapshotDir, { recursive: true });
        writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify(snapshot));
      } else if (command.args[0] === 'run' && command.args[1] === 'build') {
        writeFileSync(join(context.treeDir, 'index.html'), '<main>fake process artifact, not Astro evidence</main>');
      } else if (!state.omitReport) {
        const stage = STAGES.find((name) => command.args.includes(`tests/publication/${name}.test.ts`));
        if (stage) writeFileSync(reportPath(stage), state.rawReport ?? JSON.stringify(state.reports[stage]));
        if (command.args.includes('tests/publication-smoke.spec.ts')) writeFileSync(reportPath('browser'), state.rawReport ?? JSON.stringify(state.browser));
      }
      return { exitCode: state.exitCode, signal: state.signal };
    },
    async startPreview(input) {
      previews.push(structuredClone(input));
      return { baseUrl: 'http://127.0.0.1:47321', async close() { state.closed++; } };
    },
  } satisfies PublicationAdapterRuntime);
  return { temp, options, context, snapshot, ledger, state, commands, previews, runtime, reportPath,
    clean() { rmSync(temp, { recursive: true, force: true }); },
  };
}

// Independent positive control: materialize a JSON reporter fixture through a real
// local subprocess. It is not evidence that Astro/Vitest/Playwright passed.
export function writeReportWithSubprocess(path: string, report: unknown) {
  const result = spawnSync(process.execPath, ['-e',
    "const fs=require('node:fs');const bytes=fs.readFileSync(0);fs.writeFileSync(process.argv[1],bytes);process.stdout.write(bytes)", path,
  ], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return { stdout: result.stdout, disk: JSON.parse(readFileSync(path, 'utf8')) as unknown };
}
