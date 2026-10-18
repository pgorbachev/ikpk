import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { CiArtifact, ReadCiEvidenceOptions } from '../../scripts/lib/publication-ci.ts';
import type { CheckResult, PublicationCheckContext, PublicationCheckInput, PublicationCheckPorts } from '../../scripts/lib/publication-checks.ts';
import { PUBLICATION_CI_POLICY } from '../../scripts/lib/publish-gate.ts';

export const SHA = 'a'.repeat(40);
export const OTHER_SHA = 'b'.repeat(40);
export const REPORT_NAMES = ['web-unit-head.json', 'web-render-head.json', 'web-build-head.json'] as const;
export const API = 'https://api.github.com/repos/pgorbachev/ikpk';
export const CANARY = 'test-only-arbitrary-credential-canary';

export function ciFixture() {
  const run = {
    id: 801, head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
    path: '.github/workflows/test.yml', repository: { full_name: 'pgorbachev/ikpk' },
    head_repository: { full_name: 'pgorbachev/ikpk' },
  };
  const jobs = PUBLICATION_CI_POLICY.requiredJobs.map((name, id) => ({
    id: id + 1, name, status: 'completed', conclusion: 'success',
    steps: Array.from({ length: 20 }, (_, number) => ({ name: `step-${number}`, conclusion: 'success' })),
  }));
  const artifact: CiArtifact = {
    id: 901, name: 'publication-ci-counts', expired: false,
    archive_download_url: `${API}/actions/artifacts/901/zip`, workflow_run: { id: 801, head_sha: SHA },
  };
  const reports: Record<string, unknown> = Object.fromEntries(REPORT_NAMES.map((name, i) => [name, {
    success: true, numPassedTests: [7, 11, 13][i], numFailedTests: 0,
    numTotalTests: 1000, numPendingTests: 1000 - [7, 11, 13][i],
  }]));
  const calls: { url: URL; init?: RequestInit; method: string }[] = [];
  const reportReads: CiArtifact[] = [];
  const state = {
    main: SHA, runPages: [[run]], jobPages: [jobs], artifactPages: [[artifact]],
    reports, status: 200,
  };
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    calls.push({ url, init, method: init?.method ?? (request instanceof Request ? request.method : 'GET') });
    if (state.status !== 200) return new Response(JSON.stringify({ message: 'fixture API unavailable' }), { status: state.status });
    const page = Number(url.searchParams.get('page') ?? '1');
    let value: unknown;
    let pageCount = 1;
    if (url.pathname === '/repos/pgorbachev/ikpk/git/ref/heads/main') value = { ref: 'refs/heads/main', object: { sha: state.main } };
    else if (/\/actions\/workflows\/[^/]+\/runs$/.test(url.pathname)) {
      value = { total_count: state.runPages.flat().length, workflow_runs: state.runPages[page - 1] ?? [] };
      pageCount = state.runPages.length;
    } else if (url.pathname === '/repos/pgorbachev/ikpk/actions/runs/801/jobs') {
      value = { total_count: state.jobPages.flat().length, jobs: state.jobPages[page - 1] ?? [] };
      pageCount = state.jobPages.length;
    } else if (url.pathname === '/repos/pgorbachev/ikpk/actions/runs/801/artifacts') {
      value = { total_count: state.artifactPages.flat().length, artifacts: state.artifactPages[page - 1] ?? [] };
      pageCount = state.artifactPages.length;
    } else throw new Error(`unexpected fixture request: ${url.pathname}`);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (page < pageCount) {
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      headers.set('link', `<${next.href}>; rel="next"`);
    }
    return new Response(JSON.stringify(value), { status: 200, headers });
  };
  const readReports: NonNullable<ReadCiEvidenceOptions['readReports']> = async (selected) => {
    reportReads.push(selected);
    return state.reports;
  };
  return { state, run, jobs, artifact, reports, calls, reportReads, input: { commit: SHA, token: CANARY, fetch, readReports } };
}

export function fixtureDigest(root: string): string {
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child); else files.push(relative(root, child));
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const name of files.sort()) {
    const bytes = readFileSync(join(root, name));
    hash.update(`${Buffer.byteLength(name)}:`).update(name).update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

export function localFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-local-checks-'));
  const snapshotDir = join(temp, 'snapshot');
  mkdirSync(snapshotDir);
  const snapshot = { snapshotId: 'live-snapshot-fixture', snapshotDir };
  writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify({
    snapshotId: snapshot.snapshotId, origin: { kind: 'live' },
    provenance: { observedEntry: 9, revision: 9, highWaterMark: 9 },
  }));
  const input: PublicationCheckInput = {
    commit: SHA, destinationId: 'stand', deployMode: 'stand', paymentRole: 'ci',
    treeDir: join(temp, 'tree'), reportPath: join(temp, 'publication-report.json'),
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  };
  const events: string[] = [];
  const contexts: { port: string; context: PublicationCheckContext }[] = [];
  const results: Record<string, CheckResult> = Object.fromEntries([
    'checkSnapshot', 'checkBuild', 'checkDestination', 'checkBrowser',
    'checkPaymentAbsent', 'checkPaymentReadiness', 'checkPaymentPreflight',
  ].map((name) => [name, { conclusion: 'success', executedTests: 2 }]));
  const check = (name: string) => async (context: PublicationCheckContext): Promise<CheckResult> => {
    events.push(name); contexts.push({ port: name, context });
    return results[name];
  };
  const ports: PublicationCheckPorts = {
    async capture() { events.push('capture'); return snapshot; },
    async build(context) {
      events.push('build'); contexts.push({ port: 'build', context });
      mkdirSync(input.treeDir, { recursive: true });
      // A deliberately tiny fixture artifact, not an Astro build or production acceptance.
      writeFileSync(join(input.treeDir, 'index.html'), '<main>isolated coordinator fixture</main>');
    },
    checkSnapshot: check('checkSnapshot'), checkBuild: check('checkBuild'),
    checkDestination: check('checkDestination'), checkBrowser: check('checkBrowser'),
    checkPaymentAbsent: check('checkPaymentAbsent'), checkPaymentReadiness: check('checkPaymentReadiness'),
    checkPaymentPreflight: check('checkPaymentPreflight'),
    async digest(root) { events.push('digest'); return fixtureDigest(root); },
  };
  return { temp, input, snapshot, ports, events, contexts, results };
}
