#!/usr/bin/env node
// Node 24; exact-SHA CI admission, with optional post-CI stable Release creation.
import { readCiEvidence } from './lib/publication-ci.ts';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const API = 'https://api.github.com/repos/pgorbachev/ikpk';
const UPLOAD_API = 'https://uploads.github.com/repos/pgorbachev/ikpk/releases/';
const HELPER_ASSET = 'host-helper.tar.gz';
function githubHeaders(token?: string) {
  return { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
}

/** Attach only the already-verified helper bytes to their exact stable Release. */
export async function ensureReleaseHelperAsset(tag: string, commit: string, payload: Uint8Array, sha256: string,
                                               token: string | undefined, fetcher: typeof globalThis.fetch = globalThis.fetch,
                                               options: { historicalRelease?: boolean } = {}): Promise<void> {
  const fail = (reason: string): never => { throw new Error(`release-helper-${reason}`); };
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag) || !/^[a-f0-9]{40}$/.test(commit) ||
      !/^[a-f0-9]{64}$/.test(sha256) || !(payload instanceof Uint8Array) || payload.byteLength === 0 || payload.byteLength > 100 * 1024 * 1024 ||
      createHash('sha256').update(payload).digest('hex') !== sha256) fail('invalid-payload');
  const headers = githubHeaders(token);
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    return response;
  };
  const releaseResponse = await request(`${API}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (!releaseResponse.ok) fail('release-lookup');
  const release = await releaseResponse.json() as { id?: unknown; tag_name?: unknown; draft?: unknown; prerelease?: unknown;
    published_at?: unknown; upload_url?: unknown };
  if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || release.tag_name !== tag || release.draft !== false ||
      release.prerelease !== false || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) fail('unstable-release');
  const refResponse = await request(`${API}/git/ref/tags/${encodeURIComponent(tag)}`, { headers });
  if (!refResponse.ok) fail('tag-lookup');
  const ref = await refResponse.json() as { ref?: unknown; object?: { type?: unknown; sha?: unknown } };
  if (ref.ref !== `refs/tags/${tag}`) fail('tag-mismatch');
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    if (typeof object.sha !== 'string' || !/^[a-f0-9]{40}$/.test(object.sha)) fail('tag-mismatch');
    const annotatedResponse = await request(`${API}/git/tags/${object.sha}`, { headers });
    if (!annotatedResponse.ok) fail('tag-mismatch');
    const annotated = await annotatedResponse.json() as { sha?: unknown; object?: { type?: unknown; sha?: unknown } };
    if (annotated.sha !== object.sha) fail('tag-mismatch');
    object = annotated.object;
  }
  if (object?.type !== 'commit' || object.sha !== commit) fail('sha-mismatch');

  const listAssets = async (): Promise<Array<{ id?: unknown; name?: unknown; digest?: unknown; state?: unknown }>> => {
    const response = await request(`${API}/releases/${Number(release.id)}/assets?per_page=100`, { headers });
    if (!response.ok) fail('asset-list');
    const body = await response.json() as { total_count?: unknown; assets?: unknown };
    if (!Number.isSafeInteger(body.total_count) || !Array.isArray(body.assets) || Number(body.total_count) !== body.assets.length) fail('asset-list');
    return body.assets as Array<{ id?: unknown; name?: unknown; digest?: unknown; state?: unknown }>;
  };
  const verifyUniqueAsset = (assets: Array<{ id?: unknown; name?: unknown; digest?: unknown; state?: unknown }>): boolean => {
    const matches = assets.filter((asset) => asset.name === HELPER_ASSET);
    if (matches.length > 1) fail('duplicate-asset');
    if (matches.length === 0) return false;
    const asset = matches[0];
    if (!Number.isSafeInteger(asset.id) || Number(asset.id) <= 0 || asset.digest !== `sha256:${sha256}` || asset.state !== 'uploaded') fail('asset-mismatch');
    return true;
  };
  const assets = await listAssets();
  if (verifyUniqueAsset(assets)) return;
  if (options.historicalRelease) fail('historical-asset-missing');
  if (!token) fail('missing-upload-token');
  if (typeof release.upload_url !== 'string') fail('upload-endpoint');
  const uploadTemplate = release.upload_url as string;
  if (uploadTemplate !== `${UPLOAD_API}${Number(release.id)}/assets{?name,label}`) fail('upload-endpoint');
  const uploadUrl = `${uploadTemplate.slice(0, -'{?name,label}'.length)}?name=${encodeURIComponent(HELPER_ASSET)}`;
  const uploadResponse = await request(uploadUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/gzip' }, body: Buffer.from(payload) });
  if (uploadResponse.status !== 201) fail('asset-upload');
  const uploaded = await uploadResponse.json() as { name?: unknown; digest?: unknown; state?: unknown };
  if (uploaded.name !== HELPER_ASSET || uploaded.digest !== `sha256:${sha256}` || uploaded.state !== 'uploaded') fail('asset-upload-mismatch');
  if (!verifyUniqueAsset(await listAssets())) fail('asset-not-verifiable');
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
  let ensureHelperAsset = false;
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
    if (name === '--ensure-helper-asset' && !ensureHelperAsset) {
      ensureHelperAsset = true;
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
  const attachHelperAsset = ensureRelease || ensureHelperAsset || historicalRelease;
  if ((ensureRelease || ensureHelperAsset) && !token) throw new Error('missing-github-token');
  if (historicalRelease && (ensureRelease || ensureHelperAsset)) throw new Error('invalid-arguments');
  const evidence = await readCiEvidence({ commit, releaseTag, token,
    requireCurrentMain: !historicalRelease && !ensureRelease && !ensureHelperAsset,
    operatorAdmission: historicalRelease || ensureRelease || ensureHelperAsset,
    ...(ensureRelease ? { ensureRelease: (tag: string, sha: string) => ensureStableRelease(tag, sha, token!) } : {}),
    ...(attachHelperAsset ? { ensureHostHelperAsset: (tag: string, sha: string, payload: Uint8Array, sha256: string) =>
      ensureReleaseHelperAsset(tag, sha, payload, sha256, token, globalThis.fetch, { historicalRelease }) } : {}) });
  process.stdout.write(`${JSON.stringify({ status: 'admitted', commit, release: evidence.release,
    ...(evidence.hostHelperArtifact ? { hostHelperArtifact: evidence.hostHelperArtifact } : {}),
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
