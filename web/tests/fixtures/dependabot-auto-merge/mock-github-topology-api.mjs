import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.MOCK_GITHUB_SCENARIO, 'utf8'));
const callLog = process.env.MOCK_GITHUB_CALL_LOG;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function comparison(base, head) {
  const key = `${decodeURIComponent(base)}...${decodeURIComponent(head)}`;
  const item = scenario.comparisons[key];
  if (!item) throw new Error(`unexpected comparison ${key}`);
  return item;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const path = `${url.pathname}${url.search}`;
  appendFileSync(callLog, `${init.method ?? 'GET'} ${path}\n`);

  if (url.pathname === '/graphql') {
    return response({
      data: {
        repository: {
          object: {
            signature: {
              isValid: true,
              wasSignedByGitHub: true,
              signer: { login: 'web-flow' },
            },
          },
        },
      },
    });
  }
  if (url.pathname === '/repos/acme/ikpk/pulls/7') {
    return response({
      number: 7,
      auto_merge: { enabled_by: { login: 'branch-updater[bot]' } },
      head: { sha: 'merge-head' },
      base: { sha: 'base-head', ref: 'main' },
      user: { login: 'dependabot[bot]' },
    });
  }
  if (url.pathname === '/repos/acme/ikpk/pulls/7/files') {
    return response([{ filename: 'scripts/package-lock.json' }]);
  }
  if (url.pathname === '/repos/acme/ikpk/git/commits/merge-head' ||
      url.pathname === '/repos/acme/ikpk/commits/merge-head') {
    return response({
      sha: 'merge-head',
      parents: scenario.parents.map((sha) => ({ sha })),
      commit: { tree: { sha: scenario.mergeTree ?? 'merge-tree' } },
      tree: { sha: scenario.mergeTree ?? 'merge-tree' },
    });
  }
  if (url.pathname === '/repos/acme/ikpk/commits/parent-head/check-runs') {
    return response({ check_runs: scenario.parentEvidence ? [{
      name: 'Dependabot auto-merge / Provenance evidence',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'parent-head',
      external_id: `provenance:parent-head:${'a'.repeat(40)}`,
      details_url: 'https://github.com/acme/ikpk/actions/runs/91',
      app: { slug: 'github-actions', id: 15368 },
    }] : [] });
  }
  if (url.pathname === '/repos/acme/ikpk/actions/runs/91') {
    return response({
      event: 'pull_request_target',
      head_sha: 'parent-head',
      path: '.github/workflows/dependabot-auto-merge.yml@refs/heads/main',
      pull_requests: [{ number: 7, head: { sha: 'parent-head' } }],
      referenced_workflows: [{
        path: `acme/ikpk/.github/workflows/dependabot-auto-merge-policy.yml@${'a'.repeat(40)}`,
        sha: 'a'.repeat(40),
      }],
    });
  }
  if (url.pathname === '/repos/acme/ikpk/actions/runs/91/jobs') {
    return response({ jobs: [{ name: 'Policy / Provenance evidence', conclusion: 'success' }] });
  }
  const compare = /^\/repos\/acme\/ikpk\/compare\/([^/]+)\.\.\.([^/]+)$/.exec(url.pathname);
  if (compare) return response(comparison(compare[1], compare[2]));

  throw new Error(`unexpected GitHub API call: ${init.method ?? 'GET'} ${path}`);
};
