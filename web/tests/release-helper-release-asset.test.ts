import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as releasePreflight from '../scripts/release-preflight.ts';

const SHA = 'a'.repeat(40);
const WRONG_SHA = 'b'.repeat(40);
const TAG = 'v2026.11.5';
const API = 'https://api.github.com/repos/pgorbachev/ikpk';
const UPLOAD = 'https://uploads.github.com/repos/pgorbachev/ikpk/releases/123/assets{?name,label}';
const TOKEN = 'test-token-must-not-leak';
const PAYLOAD = Buffer.from('verified host helper tar payload');
const DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');

type Call = { url: string; method: string; body?: BodyInit | null; headers?: HeadersInit };
type Ensure = (tag: string, commit: string, payload: Uint8Array, sha256: string, token: string,
  fetcher: typeof globalThis.fetch, options?: { historicalRelease?: boolean }) => Promise<void>;

async function operation(): Promise<Ensure> {
  const candidate = (releasePreflight as unknown as { ensureReleaseHelperAsset?: Ensure }).ensureReleaseHelperAsset;
  if (!candidate) throw new Error('release-helper-asset-operation-missing');
  return candidate;
}

function githubFixture(options: { commit?: string; assets?: Array<Record<string, unknown>>;
  assetPages?: Array<Array<Record<string, unknown>>> } = {}) {
  const calls: Call[] = [];
  let assets = options.assets ?? [];
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body, headers: init?.headers });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === `${API}/releases/tags/${TAG}`) return json({ id: 123, tag_name: TAG, draft: false,
      prerelease: false, published_at: '2026-11-05T12:00:00Z', upload_url: UPLOAD });
    if (url === `${API}/git/ref/tags/${TAG}`) return json({ ref: `refs/tags/${TAG}`,
      object: { type: 'commit', sha: options.commit ?? SHA } });
    if (url.startsWith(`${API}/releases/123/assets?per_page=100`)) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const selected = options.assetPages?.[page - 1] ?? assets;
      const link = options.assetPages && page < options.assetPages.length
        ? { headers: { link: `<${API}/releases/123/assets?per_page=100&page=${page + 1}>; rel="next"` } } : {};
      return new Response(JSON.stringify(selected), { status: 200, ...link });
    }
    if (url.startsWith('https://uploads.github.com/') && method === 'POST') {
      assets = [{ id: 456, name: 'host-helper.tar.gz', digest: `sha256:${DIGEST}`, state: 'uploaded' }];
      return json(assets[0], 201);
    }
    throw new Error(`unexpected fake GitHub request: ${method} ${url}`);
  };
  return { calls, fetch };
}

describe('production Release host-helper asset', () => {
  it('attaches the checked payload only to the stable Release whose tag resolves to the admitted SHA', async () => {
    const f = githubFixture();
    await (await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch);
    const upload = f.calls.find((call) => call.method === 'POST');
    expect(upload?.url).toBe('https://uploads.github.com/repos/pgorbachev/ikpk/releases/123/assets?name=host-helper.tar.gz');
    expect(Buffer.from(await new Response(upload?.body).arrayBuffer())).toEqual(PAYLOAD);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.map((call) => new URL(call.url).hostname).every((host) =>
      host === 'api.github.com' || host === 'uploads.github.com')).toBe(true);
    expect(f.calls.some((call) => /deploy|ssh|actions\/workflows/i.test(call.url))).toBe(false);
    expect(f.calls.filter((call) => call.method === 'GET').map((call) => call.url)).toContain(`${API}/releases/123/assets?per_page=100`);
  });

  it('reuses one existing asset only when its GitHub digest matches the checked payload', async () => {
    const f = githubFixture({ assets: [{ id: 456, name: 'host-helper.tar.gz', digest: `sha256:${DIGEST}`, state: 'uploaded' }] });
    await (await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch);
    expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('reads complete paginated GitHub asset lists and detects a duplicate on a later page', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `other-${index}`, digest: null, state: 'uploaded' }));
    const existing = { id: 456, name: 'host-helper.tar.gz', digest: `sha256:${DIGEST}`, state: 'uploaded' };
    const okay = githubFixture({ assetPages: [filler, [existing]] });
    await (await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, okay.fetch);
    expect(okay.calls.some((call) => call.url.endsWith('/assets?per_page=100&page=2'))).toBe(true);
    const duplicate = githubFixture({ assetPages: [filler, [existing, { ...existing, id: 457 }]] });
    await expect((await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, duplicate.fetch)).rejects.toThrow();
    expect(duplicate.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses a different tag target SHA before uploading', async () => {
    const f = githubFixture({ commit: WRONG_SHA });
    await expect((await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch)).rejects.toThrow();
    expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses an asset with foreign bytes and duplicate same-name assets without replacing either', async () => {
    for (const assets of [
      [{ id: 456, name: 'host-helper.tar.gz', digest: `sha256:${'f'.repeat(64)}`, state: 'uploaded' }],
      [456, 457].map((id) => ({ id, name: 'host-helper.tar.gz', digest: `sha256:${DIGEST}`, state: 'uploaded' })),
    ]) {
      const f = githubFixture({ assets });
      await expect((await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch)).rejects.toThrow();
      expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
    }
  });

  it('refuses a missing helper on a historical Release without changing that Release', async () => {
    const f = githubFixture();
    await expect((await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch, { historicalRelease: true })).rejects.toThrow();
    expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('continues to admit a historical Release when its unique existing helper asset is verified', async () => {
    const f = githubFixture({ assets: [{ id: 456, name: 'host-helper.tar.gz', digest: `sha256:${DIGEST}`, state: 'uploaded' }] });
    await (await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch, { historicalRelease: true });
    expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses a missing or incorrectly hashed CI payload before any GitHub write', async () => {
    const f = githubFixture();
    const ensure = await operation();
    await expect(ensure(TAG, SHA, Buffer.alloc(0), DIGEST, TOKEN, f.fetch)).rejects.toThrow();
    await expect(ensure(TAG, SHA, PAYLOAD, '0'.repeat(64), TOKEN, f.fetch)).rejects.toThrow();
    expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('does not expose credentials or payload bytes in errors', async () => {
    const f = githubFixture({ commit: WRONG_SHA });
    let message = '';
    try { await (await operation())(TAG, SHA, PAYLOAD, DIGEST, TOKEN, f.fetch); }
    catch (error) { message = String(error); }
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(PAYLOAD.toString());
  });
});
