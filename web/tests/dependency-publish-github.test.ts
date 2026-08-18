import { describe, expect, it, vi } from 'vitest';
import { resolvePublishedHeadInputFromGitHub } from '../scripts/lib/github-published-head';

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

describe('GitHub published-head adapter', () => {
  it('uses the current deployment status and rejects an older success', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'head' });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse([{ sha: 'head', id: 42 }]);
      if (url.includes('/deployments/42/statuses')) return jsonResponse([
        { state: 'success', created_at: '2026-08-17T10:01:00Z' },
        { state: 'failure', created_at: '2026-08-17T10:02:00Z' },
      ]);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).resolves.toMatchObject({ mainHeadSha: 'head', publishedSha: null });
  });

  it('queries deployments for the current main SHA instead of relying on list order', async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'head' });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse([{ sha: 'head', id: 7 }]);
      if (url.includes('/deployments/7/statuses')) return jsonResponse([
        { state: 'success', created_at: '2026-08-17T10:01:00Z' },
      ]);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).resolves.toMatchObject({ mainHeadSha: 'head', publishedSha: 'head' });
    expect(requested.find((url) => url.includes('/deployments?'))).toContain('sha=head');
  });

  it('measures lag from the matching main push workflow run, not commit author time', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) return jsonResponse({
        sha: 'head', commit: { committer: { date: '2026-08-17T08:00:00Z' } },
      });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse([]);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).resolves.toMatchObject({ mainHeadCreatedAt: '2026-08-17T10:00:00Z' });
  });

  it('treats a new deployment with no statuses as not published yet', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'head' });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse([{ sha: 'head', id: 9 }]);
      if (url.includes('/deployments/9/statuses')) return jsonResponse([]);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).resolves.toMatchObject({ publishedSha: null });
  });

  it.each([
    { deployments: [{ sha: 'head' }], statuses: [], label: 'deployment without id' },
    {
      deployments: [{ sha: 'head', id: 10 }],
      statuses: [{ created_at: '2026-08-17T10:01:00Z' }],
      label: 'status without state',
    },
  ])('fails closed for a malformed $label', async ({ deployments, statuses }) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'head' });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse(deployments);
      if (url.includes('/deployments/10/statuses')) return jsonResponse(statuses);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).rejects.toThrow();
  });

  it('validates every deployment record before accepting a successful one', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'head' });
      if (url.includes('/actions/workflows/test.yml/runs')) return jsonResponse({
        workflow_runs: [{ head_sha: 'head', event: 'push', created_at: '2026-08-17T10:00:00Z' }],
      });
      if (url.includes('/deployments?')) return jsonResponse([{ sha: 'head', id: 1 }, { sha: 'head' }]);
      if (url.includes('/deployments/1/statuses')) return jsonResponse([
        { state: 'success', created_at: '2026-08-17T10:01:00Z' },
      ]);
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(resolvePublishedHeadInputFromGitHub({
      api: 'https://api.github.test', repository: 'o/r', token: 'token', maxLagMs: 1_800_000, fetch,
    })).rejects.toThrow(/incomplete deployment/);
  });
});
