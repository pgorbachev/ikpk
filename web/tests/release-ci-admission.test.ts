import { describe, expect, it } from 'vitest';
import { readCiEvidence } from '../scripts/lib/publication-ci.ts';
import { ciFixture, OTHER_SHA, SHA } from './helpers/publication-readers-fixtures.ts';

const workflows = ['lint.yml', 'security.yml', 'lighthouse.yml'];
const jobs: Record<string, string[]> = {
  'lint.yml': ['web checks', 'cms checks', 'scripts checks', 'payments checks', 'OpenSpec integration'],
  'security.yml': ['Secret scan', 'Runtime dependency audit (web)', 'Runtime dependency audit (scripts)', 'Runtime dependency audit (payments)', 'CMS runtime dependency audit (report only)'],
  'lighthouse.yml': ['Lighthouse budgets (4 templates, median of 5)'],
};
const TAG = 'v1.2.3';
function fixture() {
  const base = ciFixture();
  const runs = new Map(workflows.map((file, index) => [file, [{ ...base.run, id: 900 + index, path: `.github/workflows/${file}` }]]));
  const calls: string[] = [];
  const release = { id: 41, tag_name: TAG, draft: false, prerelease: false, published_at: '2026-10-20T10:00:00Z', target_commitish: 'main' };
  const tag = { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: SHA } };
  const annotated = new Map<string, { object: { type: string; sha: string } }>();
  const state = { releaseStatus: 200, jobFault: '' };
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request : request.url);
    if (url.pathname.endsWith(`/releases/tags/${TAG}`)) {
      return new Response(JSON.stringify(release), { status: state.releaseStatus });
    }
    if (url.pathname.endsWith(`/git/ref/tags/${TAG}`)) return new Response(JSON.stringify(tag));
    const annotation = url.pathname.match(/\/git\/tags\/([a-f0-9]{40})$/)?.[1];
    if (annotation && annotated.has(annotation)) return new Response(JSON.stringify({ sha: annotation, ...annotated.get(annotation) }));
    const jobRun = url.pathname.match(/\/actions\/runs\/([0-9]+)\/jobs$/)?.[1];
    const jobFile = workflows.find((file) => runs.get(file)?.some((run) => String(run.id) === jobRun));
    if (jobRun && jobFile) {
      const results = jobs[jobFile].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
      if (state.jobFault === `${jobFile}:absent`) results.shift();
      if (state.jobFault === `${jobFile}:duplicate`) results.push(results[0]);
      if (state.jobFault === `${jobFile}:skipped`) results[0].conclusion = 'skipped';
      if (state.jobFault === `${jobFile}:unfinished`) results[0].status = 'in_progress';
      return new Response(JSON.stringify({ total_count: results.length, jobs: results }));
    }
    const file = url.pathname.match(/\/actions\/workflows\/([^/]+)\/runs$/)?.[1];
    if (file && runs.has(file)) {
      calls.push(file);
      const values = runs.get(file)!;
      return new Response(JSON.stringify({ total_count: values.length, workflow_runs: values }), { headers: { 'content-type': 'application/json' } });
    }
    return base.input.fetch(request, init);
  };
  return { base, runs, calls, release, tag, annotated, state, input: { ...base.input, fetch, releaseTag: TAG } };
}

describe('release CI admission requires all mandatory canonical exact-SHA workflows', () => {
  it('checks lint, security and Lighthouse as well as Tests before admitting the source', async () => {
    const f = fixture();
    await expect(readCiEvidence(f.input)).resolves.toMatchObject({ commit: SHA, conclusion: 'success' });
    expect([...new Set(f.calls)].sort()).toEqual([...workflows].sort());
  });

  it('accepts an annotated tag only after peeling it to the exact source SHA', async () => {
    const f = fixture(); const annotation = 'c'.repeat(40);
    f.tag.object = { type: 'tag', sha: annotation };
    f.annotated.set(annotation, { object: { type: 'commit', sha: SHA } });
    await expect(readCiEvidence(f.input)).resolves.toMatchObject({ commit: SHA });
  });

  it('the published release must exist, be stable, and be published for the requested version', async () => {
    for (const mutation of [{ draft: true }, { prerelease: true }, { published_at: null }, { published_at: 'invalid' },
      { id: 0 }, { tag_name: 'v9.9.9' }]) {
      const f = fixture(); Object.assign(f.release, mutation);
      await expect(readCiEvidence(f.input), JSON.stringify(mutation)).rejects.toThrow();
    }
    const f = fixture(); f.state.releaseStatus = 404;
    await expect(readCiEvidence(f.input)).rejects.toThrow();
  });

  it('release target_commitish main cannot authorize a tag pointing at different bytes', async () => {
    const f = fixture(); f.tag.object.sha = OTHER_SHA;
    await expect(readCiEvidence(f.input)).rejects.toThrow();
  });

  it('a mismatched tag ref cannot impersonate the requested version', async () => {
    const f = fixture(); f.tag.ref = 'refs/tags/v9.9.9';
    await expect(readCiEvidence(f.input)).rejects.toThrow();
  });

  it('an annotated release tag cannot authorize an earlier commit', async () => {
    const f = fixture(); const annotation = 'c'.repeat(40);
    f.tag.object = { type: 'tag', sha: annotation };
    f.annotated.set(annotation, { object: { type: 'commit', sha: OTHER_SHA } });
    await expect(readCiEvidence(f.input)).rejects.toThrow();
  });

  for (const file of workflows) {
    for (const fault of ['absent', 'duplicate', 'skipped', 'unfinished']) {
      it(`refuses ${file} with an ${fault} mandatory job despite a green workflow conclusion`, async () => {
        const f = fixture(); f.state.jobFault = `${file}:${fault}`;
        await expect(readCiEvidence(f.input)).rejects.toThrow();
      });
    }
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
      it(`refuses ${file} ${conclusion} even when Tests is green`, async () => {
        const f = fixture(); f.runs.get(file)![0].conclusion = conclusion;
        await expect(readCiEvidence(f.input)).rejects.toThrow();
      });
    }
    for (const status of ['queued', 'in_progress']) {
      it(`refuses ${file} ${status} without reusing a successful conclusion`, async () => {
        const f = fixture(); f.runs.get(file)![0].status = status;
        await expect(readCiEvidence(f.input)).rejects.toThrow();
      });
    }
    it(`refuses absent ${file} evidence`, async () => {
      const f = fixture(); f.runs.set(file, []);
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    });
    it(`refuses ${file} evidence for another SHA`, async () => {
      const f = fixture(); f.runs.get(file)![0].head_sha = OTHER_SHA;
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    });
    it(`refuses a PR, fork, branch or foreign workflow masquerading as green ${file}`, async () => {
      for (const mutation of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'dev' },
        { repository: { full_name: 'someone/fork' } }, { head_repository: { full_name: 'someone/fork' } },
        { path: '.github/workflows/other.yml' }]) {
        const f = fixture(); Object.assign(f.runs.get(file)![0], mutation);
        await expect(readCiEvidence(f.input), JSON.stringify(mutation)).rejects.toThrow();
      }
    });
    it(`latest ${file} failure cannot be hidden by an older green run`, async () => {
      const f = fixture(); const green = f.runs.get(file)![0];
      f.runs.set(file, [green, { ...green, id: green.id + 1000, conclusion: 'failure' }]);
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    });
    it(`latest ${file} pending run cannot be hidden by an older green run`, async () => {
      const f = fixture(); const green = f.runs.get(file)![0];
      f.runs.set(file, [green, { ...green, id: green.id + 1000, status: 'queued', conclusion: '' }]);
      await expect(readCiEvidence(f.input)).rejects.toThrow();
    });
  }
});
