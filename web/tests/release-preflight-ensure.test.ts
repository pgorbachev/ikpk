import { describe, expect, it } from 'vitest';
import { ensureStableRelease } from '../scripts/release-preflight.ts';
import { readCiEvidence } from '../scripts/lib/publication-ci.ts';
import { PUBLICATION_CI_POLICY } from '../scripts/lib/publish-gate.ts';
import { createHash } from 'node:crypto';

const SHA = 'a'.repeat(40);
const TAG = 'v2026.1102.1';
const API = 'https://api.github.com/repos/pgorbachev/ikpk';

describe('release-preflight stable Release callback', () => {
  it('reuses an existing Release without a write', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    };
    await ensureStableRelease(TAG, SHA, 'fake-token', fetch);
    expect(calls).toEqual([{ url: `${API}/releases/tags/${TAG}`, method: 'GET' }]);
  });

  it('creates a missing Release only after its caller invokes the callback', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === `${API}/releases/tags/${TAG}` || url === `${API}/git/ref/tags/${TAG}`) {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      return new Response('{}', { status: 201 });
    };
    await ensureStableRelease(TAG, SHA, 'fake-token', fetch);
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST']);
    expect(calls[2]).toMatchObject({ url: `${API}/releases`, method: 'POST' });
    expect(JSON.parse(calls[2].body!)).toMatchObject({ tag_name: TAG, target_commitish: SHA, draft: false, prerelease: false });
  });

  it('refuses a tag already bound to different source bytes before Release creation', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === `${API}/releases/tags/${TAG}`) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: 'b'.repeat(40) } }));
    };
    await expect(ensureStableRelease(TAG, SHA, 'fake-token', fetch)).rejects.toThrow('release-tag-already-points-elsewhere');
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.startsWith('POST '))).toBe(false);
  });
});

describe('readCiEvidence with the real stable-release callback', () => {
  const requiredMainJobs = PUBLICATION_CI_POLICY.requiredJobs;
  const requiredWorkflowJobs: Record<string, string[]> = {
    'lint.yml': ['web checks', 'cms checks', 'scripts checks', 'payments checks', 'OpenSpec integration'],
    'security.yml': ['Secret scan', 'Runtime dependency audit (web)', 'Runtime dependency audit (scripts)',
      'Runtime dependency audit (payments)', 'CMS runtime dependency audit (report only)'],
    'lighthouse.yml': ['Lighthouse budgets (4 templates, median of 5)'],
  };

  function fixture(options: { invalidCi?: boolean; wrongTagSha?: boolean; staleArtifact?: boolean; missingHelper?: boolean;
    wrongJobAttempt?: boolean; wrongWorkflowJobAttempt?: boolean } = {}) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    let releaseExists = false;
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (url === `${API}/releases/tags/${TAG}`) {
        return releaseExists ? json({ tag_name: TAG, draft: false, prerelease: false, id: 123,
          published_at: '2026-11-02T00:00:00Z' }) : json({ message: 'Not Found' }, 404);
      }
      if (url === `${API}/git/ref/tags/${TAG}`) {
        if (!releaseExists) return options.wrongTagSha
          ? json({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: 'b'.repeat(40) } })
          : json({ message: 'Not Found' }, 404);
        return json({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: SHA } });
      }
      if (url === `${API}/releases` && method === 'POST') {
        releaseExists = true;
        return json({ id: 123 }, 201);
      }
      const workflow = Object.keys(requiredWorkflowJobs).find((file) => url.includes(`/actions/workflows/${file}/runs?`));
      if (workflow || url.includes('/actions/workflows/test.yml/runs?')) {
        const isMain = !workflow;
        const id = isMain ? 900 : workflow === 'lint.yml' ? 901 : workflow === 'security.yml' ? 902 : 903;
        const path = isMain ? '.github/workflows/test.yml' : `.github/workflows/${workflow}`;
        return json({ total_count: 1, workflow_runs: [{ id, head_sha: SHA, head_branch: 'main', event: 'push',
          status: 'completed', conclusion: options.invalidCi && isMain ? 'failure' : 'success', run_attempt: 1,
          path, repository: { full_name: 'pgorbachev/ikpk' }, head_repository: { full_name: 'pgorbachev/ikpk' } }] });
      }
      const jobsMatch = url.match(/\/actions\/runs\/(\d+)\/jobs\?/);
      if (jobsMatch) {
        const isMain = jobsMatch[1] === '900';
        const names = isMain ? [...requiredMainJobs, 'Package host helper artifact'] : requiredWorkflowJobs[Number(jobsMatch[1]) === 901 ? 'lint.yml' :
          Number(jobsMatch[1]) === 902 ? 'security.yml' : 'lighthouse.yml'];
        return json({ total_count: names.length, jobs: names.map((name) => ({ name,
          run_attempt: (options.wrongJobAttempt && isMain && name === 'Unit and build tests') ||
            (options.wrongWorkflowJobAttempt && jobsMatch[1] === '901' && name === 'web checks') ? 0 : 1,
          status: 'completed', conclusion: 'success', started_at: '2026-11-02T17:13:18Z', completed_at: '2026-11-02T17:34:46Z' })) });
      }
      if (url === `${API}/actions/runs/900/artifacts?per_page=100`) {
        const runArtifacts = [{
        id: 777, name: 'publication-ci-counts', expired: false,
        created_at: options.staleArtifact ? '2026-11-02T17:00:00Z' : '2026-11-02T17:20:00Z',
        archive_download_url: `${API}/actions/artifacts/777/zip`,
        workflow_run: { id: 900, head_sha: SHA },
      }, ...(!options.missingHelper ? [{ id: 778, name: 'host-helper-900-1', expired: false,
        created_at: '2026-11-02T17:20:00Z', digest: `sha256:${'c'.repeat(64)}`,
        archive_download_url: `${API}/actions/artifacts/778/zip`, workflow_run: { id: 900, head_sha: SHA, head_branch: 'main' } }] : [])];
        return json({ total_count: runArtifacts.length, artifacts: runArtifacts });
      }
      throw new Error(`unexpected fake API request: ${method} ${url}`);
    };
    const reports = async () => ({ 'web-unit-head.json': { numPassedTests: 1, numFailedTests: 0 },
      'web-render-head.json': { numPassedTests: 1, numFailedTests: 0 },
      'web-build-head.json': { numPassedTests: 1, numFailedTests: 0 } });
    const read = (ensureRelease?: (tag: string, sha: string) => Promise<void>, helper?: {
      ensureHostHelperAsset: (tag: string, sha: string, payload: Uint8Array, digest: string) => Promise<void>;
      readHostHelperPayload: () => Promise<Uint8Array>;
    }) => readCiEvidence({
      commit: SHA, releaseTag: TAG, token: 'fake-token', fetch, operatorAdmission: true,
      requireCurrentMain: false, readReports: reports, ensureRelease, ...helper,
    });
    return { calls, fetch, read };
  }

  it('finishes all exact-SHA CI reads before creating and re-verifying the Release', async () => {
    const f = fixture();
    await f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch));
    const createIndex = f.calls.findIndex((call) => call.url === `${API}/releases` && call.method === 'POST');
    const ensureIndex = f.calls.findIndex(({ url }) => url === `${API}/releases/tags/${TAG}`);
    expect(createIndex).toBeGreaterThan(0);
    expect(ensureIndex).toBeGreaterThan(0);
    expect(f.calls.slice(0, ensureIndex).some(({ url }) => url.includes('/actions/'))).toBe(true);
    expect(f.calls.slice(0, ensureIndex).every(({ url }) => !url.includes('/releases') && !url.includes('/git/ref/tags/'))).toBe(true);
    expect(createIndex).toBeGreaterThan(ensureIndex);
    expect(f.calls.slice(createIndex + 1).map(({ url }) => url)).toEqual([
      `${API}/releases/tags/${TAG}`, `${API}/git/ref/tags/${TAG}`,
    ]);
    expect(JSON.parse(f.calls[createIndex].body!)).toMatchObject({ tag_name: TAG, target_commitish: SHA });
  });

  it('does not create a Release when exact-SHA CI is invalid', async () => {
    const f = fixture({ invalidCi: true });
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch))).rejects.toThrow();
    expect(f.calls.some(({ url, method }) => url === `${API}/releases` && method === 'POST')).toBe(false);
  });

  it('passes only the exact successful run helper bytes to the Release asset callback after CI admission', async () => {
    const f = fixture(); const payload = Buffer.from('helper from exact Tests run'); const digest = createHash('sha256').update(payload).digest('hex');
    let callbacks = 0;
    const evidence = await f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch), {
      readHostHelperPayload: async () => payload,
      ensureHostHelperAsset: async (tag, sha, bytes, sha256) => {
        callbacks++;
        expect([tag, sha, Buffer.from(bytes), sha256]).toEqual([TAG, SHA, payload, digest]);
        expect(f.calls.some(({ url }) => url.includes('/actions/workflows/test.yml/runs?'))).toBe(true);
      },
    });
    expect(callbacks).toBe(1);
    expect(evidence.hostHelperArtifact).toMatchObject({ artifactId: 778, runId: 900, attempt: 1, payloadSha256: digest });
  });

  it('does not invoke a Release asset callback when the exact helper run artifact is absent', async () => {
    const f = fixture({ missingHelper: true }); let callbacks = 0;
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch), { readHostHelperPayload: async () => Buffer.from('helper'),
      ensureHostHelperAsset: async () => { callbacks++; } })).rejects.toThrow();
    expect(callbacks).toBe(0);
  });

  it('refuses publication counts created before the successful current attempt', async () => {
    const f = fixture({ staleArtifact: true });
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch))).rejects.toThrow();
    expect(f.calls.some(({ url, method }) => url === `${API}/releases` && method === 'POST')).toBe(false);
  });

  it('refuses a required CI job that belongs to a different attempt', async () => {
    const f = fixture({ wrongJobAttempt: true });
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch))).rejects.toThrow();
    expect(f.calls.some(({ url, method }) => url === `${API}/releases` && method === 'POST')).toBe(false);
  });

  it('refuses a release workflow job that belongs to a different attempt', async () => {
    const f = fixture({ wrongWorkflowJobAttempt: true });
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch))).rejects.toThrow();
    expect(f.calls.some(({ url, method }) => url === `${API}/releases` && method === 'POST')).toBe(false);
  });

  it('refuses a tag-SHA mismatch without creating a Release', async () => {
    const f = fixture({ wrongTagSha: true });
    await expect(f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch)))
      .rejects.toThrow('release-tag-already-points-elsewhere');
    expect(f.calls.some(({ url, method }) => url === `${API}/releases` && method === 'POST')).toBe(false);
  });

  it('keeps the requested SHA as admission identity and release target without querying current main', async () => {
    const f = fixture();
    const evidence = await f.read((tag, sha) => ensureStableRelease(tag, sha, 'fake-token', f.fetch));
    expect(evidence.commit).toBe(SHA);
    expect(evidence.operatorAdmission?.sourceSha).toBe(SHA);
    expect(f.calls.some(({ url }) => url === `${API}/git/ref/heads/main`)).toBe(false);
    expect(f.calls.filter(({ url }) => url.includes('/actions/workflows/')).every(({ url }) => url.includes(`head_sha=${SHA}`))).toBe(true);
    const create = f.calls.find(({ url, method }) => url === `${API}/releases` && method === 'POST');
    expect(JSON.parse(create!.body!).target_commitish).toBe(SHA);
  });
});
