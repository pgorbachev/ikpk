import { SOURCE_CI_JOBS } from '../../publication-launcher.mjs';
// Test-only Node --import bootstrap for installed-launcher subprocess fixtures.
// The real gate still validates the complete responses; no network is contacted.
export function sourceCiFixtureScript(commit) {
  return `globalThis.fetch = (${fixtureFetch.toString()})(${JSON.stringify(commit)}, ${JSON.stringify(SOURCE_CI_JOBS)});\n`;
}
function fixtureFetch(commit, names) {
  return async function (input) {
    const url = new URL(input);
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/pgorbachev/ikpk/')) throw new Error('unexpected fixture request');
    if (url.pathname.includes('/git/ref/heads/')) return Response.json({ ref: 'refs/heads/main', object: { sha: commit } });
    if (url.pathname.endsWith('/jobs')) return Response.json({ total_count: names.length,
      jobs: names.map(name => ({ name, status: 'completed', conclusion: 'success' })) });
    return Response.json({ total_count: 1, workflow_runs: [{ id: 1, head_sha: commit, head_branch: 'main',
      event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/test.yml',
      repository: { full_name: 'pgorbachev/ikpk' }, head_repository: { full_name: 'pgorbachev/ikpk' } }] });
  };
}
