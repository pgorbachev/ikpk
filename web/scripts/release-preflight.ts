#!/usr/bin/env node
// Node 24; exact-SHA CI admission, with optional post-CI stable Release creation.
import { readCiEvidence } from './lib/publication-ci.ts';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com/repos/pgorbachev/ikpk';
function githubHeaders(token: string) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
}

export async function ensureStableRelease(tag: string, commit: string, token: string,
                                          fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<void> {
  const headers = githubHeaders(token);
  const existing = await fetcher(`${API}/releases/tags/${encodeURIComponent(tag)}`, { headers, redirect: 'error' });
  if (existing.ok) return; // readCiEvidence verifies publication, tag target and exact SHA afterward.
  if (existing.status !== 404) throw new Error('release-lookup-failed');

  const ref = await fetcher(`${API}/git/ref/tags/${encodeURIComponent(tag)}`, { headers, redirect: 'error' });
  if (ref.ok) {
    const body = await ref.json() as { ref?: unknown; object?: { type?: unknown; sha?: unknown } };
    if (body.ref !== `refs/tags/${tag}` || body.object?.type !== 'commit' || body.object.sha !== commit) {
      throw new Error('release-tag-already-points-elsewhere');
    }
  } else if (ref.status !== 404) {
    throw new Error('release-tag-lookup-failed');
  }
  const created = await fetcher(`${API}/releases`, { method: 'POST', headers, redirect: 'error',
    body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: tag,
      body: `Automated IKPK release for ${commit}.`, draft: false, prerelease: false }) });
  if (!created.ok && created.status !== 422) throw new Error('release-create-failed');
  // A concurrent creator may win; the caller always re-reads and verifies the stable Release and peeled SHA.
}

async function main() {
try {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  let historicalRelease = false;
  let ensureRelease = false;
  for (let index = 0; index < args.length;) {
    const name = args[index], value = args[index + 1];
    if (name === '--historical-release' && !historicalRelease) {
      historicalRelease = true;
      index++;
      continue;
    }
    if (name === '--ensure-release' && !ensureRelease) {
      ensureRelease = true;
      index++;
      continue;
    }
    if (!['--release-tag', '--commit'].includes(name) || options.has(name) || !value || value.startsWith('--')) throw new Error('invalid-arguments');
    options.set(name, value);
    index += 2;
  }
  const commit = options.get('--commit') ?? '';
  const releaseTag = options.get('--release-tag') ?? '';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (ensureRelease && !token) throw new Error('missing-github-token');
  const evidence = await readCiEvidence({ commit, releaseTag, token,
    requireCurrentMain: !historicalRelease && !ensureRelease, operatorAdmission: historicalRelease || ensureRelease,
    ...(ensureRelease ? { ensureRelease: (tag: string, sha: string) => ensureStableRelease(tag, sha, token!) } : {}) });
  process.stdout.write(`${JSON.stringify({ status: 'admitted', commit, release: evidence.release,
    historicalRelease: historicalRelease || ensureRelease, ...( (historicalRelease || ensureRelease) && evidence.operatorAdmission
      ? { operatorAdmission: evidence.operatorAdmission } : {}),
    runs: [{ workflow: evidence.workflow, runId: evidence.runId }, ...evidence.workflows ?? []] })}\n`);
} catch {
  // HTTP bodies, credentials and report contents never enter the operator log.
  process.stderr.write('Release refused: require --release-tag vX.Y.Z --commit <full SHA> and successful exact-SHA CI with a verified stable Release.\n');
  process.exitCode = 1;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
