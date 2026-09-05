import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.MOCK_GITHUB_SCENARIO, 'utf8'));
const callLog = process.env.MOCK_GITHUB_CALL_LOG;

function log(method, path) {
  appendFileSync(callLog, `${method} ${path}\n`);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const path = `${url.pathname}${url.search}`;
  const method = init.method ?? 'GET';
  log(method, path);

  if (url.pathname === '/graphql') {
    return response({
      data: {
        repository: {
          object: {
            signature: scenario.signature ?? {
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
      auto_merge: scenario.autoMergeEnabled ? { enabled_by: { login: 'maintainer' } } : null,
      head: { sha: scenario.currentHeadSha ?? scenario.eventHeadSha },
      base: { sha: 'b'.repeat(40), ref: 'main' },
      user: { login: scenario.prAuthor ?? 'dependabot[bot]' },
    });
  }

  if (url.pathname === '/repos/acme/ikpk/pulls/7/files') {
    return response(scenario.files ?? [{ filename: 'scripts/package-lock.json' }]);
  }

  if (url.pathname.startsWith('/repos/acme/ikpk/contents/')) {
    const body = scenario.contents?.[url.pathname];
    if (!body) return response({ message: 'not found' }, 404);
    return response({ type: 'file', encoding: 'base64', content: Buffer.from(body).toString('base64') });
  }

  if (url.pathname === '/repos/acme/ikpk/commits/' + (scenario.currentHeadSha ?? scenario.eventHeadSha) + '/check-runs') {
    return response({ check_runs: scenario.headEvidenceChecks ?? [] });
  }

  if (url.pathname === '/repos/acme/ikpk/actions/runs/91') {
    return response({
      id: 91,
      run_attempt: 2,
      event: 'workflow_run',
      path: '.github/workflows/dependabot-auto-merge.yml@refs/heads/main',
      display_title: 'Dependabot auto-merge source=81 attempt=1',
      referenced_workflows: [{
        path: `acme/ikpk/.github/workflows/dependabot-auto-merge-policy.yml@${'a'.repeat(40)}`,
        sha: 'a'.repeat(40),
      }],
    });
  }

  if (url.pathname === '/repos/acme/ikpk/actions/runs/81') {
    return response({
      id: 81,
      run_attempt: 1,
      event: 'pull_request_target',
      path: '.github/workflows/dependabot-auto-merge-signal.yml@refs/heads/main',
      conclusion: 'success',
      actor: { login: 'dependabot[bot]' },
      pull_requests: [{ number: 7, head: { sha: scenario.currentHeadSha ?? scenario.eventHeadSha } }],
    });
  }

  if (url.pathname === '/repos/acme/ikpk/actions/runs/91/attempts/2/jobs') {
    return response({ jobs: [{ name: 'Policy / Provenance evidence', conclusion: 'success' }] });
  }

  throw new Error(`unexpected GitHub API call: ${method} ${path}`);
};
