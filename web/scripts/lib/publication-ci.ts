import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLICATION_CI_POLICY, ciEvidenceProblem, type CiEvidence } from './publish-gate.ts';

export interface CiArtifact {
  id: number; name: string; archive_download_url: string; expired?: boolean;
  workflow_run?: { id: number; head_sha?: string };
}
export interface ReadCiEvidenceOptions {
  commit: string; token?: string; fetch?: typeof globalThis.fetch;
  readReports?: (artifact: CiArtifact, context: { fetch: typeof globalThis.fetch; token?: string }) => Promise<Record<string, unknown>>;
}
interface WorkflowRun {
  id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string;
  path: string; repository: { full_name: string }; head_repository: { full_name: string };
}
interface Job { name: string; status: string; conclusion: string }
const API = `https://api.github.com/repos/${PUBLICATION_CI_POLICY.repository}`;
const REPORT_NAMES = ['web-unit-head.json', 'web-render-head.json', 'web-build-head.json'];
const headers = (token?: string): Record<string, string> => ({ Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) });

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`ci-read-failed:HTTP-${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('ci-response-too-large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

/** Download only this run's named reports. Never extract archive paths or forward API auth to storage. */
async function downloadReports(artifact: CiArtifact, context: { fetch: typeof globalThis.fetch; token?: string }): Promise<Record<string, unknown>> {
  const url = `${API}/actions/artifacts/${artifact.id}/zip`;
  if (artifact.archive_download_url !== url) throw new Error('untrusted-artifact-url');
  let response = await context.fetch(url, { method: 'GET', headers: headers(context.token), redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status === 302) {
    const location = response.headers.get('location');
    if (!location || new URL(location).protocol !== 'https:') throw new Error('invalid-artifact-redirect');
    response = await context.fetch(location, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000) });
  }
  const bytes = await readLimited(response, 10 * 1024 * 1024);
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-ci-reports-'));
  try {
    const zip = join(directory, 'reports.zip');
    writeFileSync(zip, bytes, { mode: 0o600, flag: 'wx' });
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n');
    if (entries.length !== REPORT_NAMES.length || REPORT_NAMES.some((name) => entries.filter((entry) => entry === name).length !== 1)) throw new Error('unexpected-ci-report-archive');
    return Object.fromEntries(REPORT_NAMES.map((name) => [name,
      JSON.parse(execFileSync('/usr/bin/unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) as unknown,
    ]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Read-only GitHub API. Policy and endpoints are fixed, never selected by an operator report. */
export async function readCiEvidence(options: ReadCiEvidenceOptions): Promise<CiEvidence> {
  if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('invalid-main-sha');
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request(url: string): Promise<{ response: Response; data: Record<string, unknown> }> {
    if (!url.startsWith(`${API}/`)) throw new Error('untrusted-ci-endpoint');
    const response = await fetcher(url, { method: 'GET', headers: headers(options.token), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const data = JSON.parse((await readLimited(response, 16 * 1024 * 1024)).toString('utf8')) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('malformed-ci-response');
    return { response, data };
  }
  async function list<T>(initial: string, key: string): Promise<T[]> {
    const result: T[] = []; const seen = new Set<string>(); let url: string | undefined = initial;
    while (url) {
      if (seen.has(url) || seen.size >= 100) throw new Error('invalid-ci-pagination');
      seen.add(url);
      const { response, data } = await request(url);
      if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count) || Number(data.total_count) < 0) throw new Error('malformed-ci-page');
      result.push(...data[key] as T[]);
      const next: string | undefined = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (next && (new URL(next).origin !== new URL(initial).origin || new URL(next).pathname !== new URL(initial).pathname)) throw new Error('untrusted-ci-pagination');
      if (!next && result.length !== data.total_count) throw new Error('incomplete-ci-pages');
      url = next;
    }
    return result;
  }
  const { data: main } = await request(`${API}/git/ref/heads/main`);
  if (main.ref !== 'refs/heads/main' || (main.object as { sha?: string } | undefined)?.sha !== options.commit) throw new Error('head-moved');
  const runs = await list<WorkflowRun>(`${API}/actions/workflows/test.yml/runs?branch=main&head_sha=${options.commit}&per_page=100`, 'workflow_runs');
  const run = runs.filter((candidate) => candidate.head_sha === options.commit && candidate.head_branch === 'main' &&
    candidate.path === PUBLICATION_CI_POLICY.workflow && candidate.repository?.full_name === PUBLICATION_CI_POLICY.repository &&
    candidate.head_repository?.full_name === PUBLICATION_CI_POLICY.repository && ['push', 'schedule'].includes(candidate.event))
    .sort((a, b) => b.id - a.id)[0];
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('no-successful-mandatory-main-run');
  const jobs = await list<Job>(`${API}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, 'jobs');
  for (const name of PUBLICATION_CI_POLICY.requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw new Error(`required-ci-job:${name}`);
  }
  const artifacts = await list<CiArtifact>(`${API}/actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts');
  const named = artifacts.filter((artifact) => artifact.name === 'publication-ci-counts');
  const artifact = named[0];
  if (named.length !== 1 || artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
      artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== options.commit ||
      artifact.archive_download_url !== `${API}/actions/artifacts/${artifact.id}/zip`) throw new Error('missing-trusted-ci-counts');
  const reports = await (options.readReports ?? downloadReports)(artifact, { fetch: fetcher, token: options.token });
  let count = 0;
  for (const name of REPORT_NAMES) {
    const report = reports[name] as { numPassedTests?: number; numFailedTests?: number } | undefined;
    if (!report || !Number.isSafeInteger(report.numPassedTests) || Number(report.numPassedTests) <= 0 || report.numFailedTests !== 0) throw new Error(`ci-report-count:${name}:${report?.numPassedTests ?? 0}`);
    count += report.numPassedTests!;
  }
  const evidence: CiEvidence = { repository: PUBLICATION_CI_POLICY.repository, workflow: PUBLICATION_CI_POLICY.workflow,
    branch: 'main', commit: options.commit, runId: run.id, event: run.event, conclusion: 'success', executedTests: count,
    jobs: jobs.filter((job) => PUBLICATION_CI_POLICY.requiredJobs.includes(job.name)).map(({ name }) => ({ name, conclusion: 'success' })),
  };
  const problem = ciEvidenceProblem(evidence, options.commit);
  if (problem) throw new Error(problem);
  return evidence;
}
