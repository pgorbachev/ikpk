import type { PublicationRecord } from './publish-gate.ts';

type Pair = { commit: string; snapshotId: string };
export function comparePublishedState(input: {
  expected?: Pair;
  observed: Pair | null;
  publications?: PublicationRecord[];
  destinationId?: string;
  pendingDestinations?: string[];
}): { status: 'match' | 'mismatch' | 'unreadable'; differing?: ('commit' | 'snapshotId')[]; reason?: string } {
  if (input.pendingDestinations?.includes(input.destinationId ?? '')) {
    return { status: 'mismatch', reason: 'unfinished-publication-record' };
  }
  if (input.observed === null) return { status: 'unreadable' };
  const expected = input.publications === undefined ? input.expected :
    input.publications.filter((record) => record.destinationId === input.destinationId).at(-1);
  if (!expected) return { status: 'unreadable', reason: 'no-publication-record-for-destination' };
  const differing: ('commit' | 'snapshotId')[] = [];
  if (expected.commit !== input.observed.commit) differing.push('commit');
  if (expected.snapshotId !== input.observed.snapshotId) differing.push('snapshotId');
  if (differing.length === 0) return { status: 'match' };
  return { status: 'mismatch', differing };
}

/** Verify the served pair and health before completing a publication or rollback. */
export async function verifyServedPublication(pair: Pair, origin: URL, fetch: typeof globalThis.fetch): Promise<void> {
  const release = await servingResponse('/release.json', origin, fetch);
  const body = await boundedReleaseJson(release);
  if (!body || body.commit !== pair.commit || body.snapshotId !== pair.snapshotId) throw new Error('served release identity mismatch');
  const health = await servingResponse('/', origin, fetch);
  await health.body?.cancel();
}

/** Follow redirects explicitly so a foreign host is never contacted. */
async function servingResponse(path: string, origin: URL, fetch: typeof globalThis.fetch): Promise<Response> {
  let url = new URL(path, origin); const seen = new Set<string>();
  for (let count = 0; count < 6; count++) {
    if (url.hostname !== origin.hostname || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) {
      throw new Error('unsafe serving redirect');
    }
    seen.add(url.href);
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (response.url && new URL(response.url).hostname !== origin.hostname) {
      await response.body?.cancel(); throw new Error('serving host mismatch');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('serving redirect missing location');
      url = new URL(location, url); continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`serving HTTP ${response.status}`); }
    return response;
  }
  throw new Error('too many serving redirects');
}

async function boundedReleaseJson(response: Response): Promise<{ commit?: unknown; snapshotId?: unknown } | null> {
  if (!response.body) throw new Error('missing release response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > 32_768) throw new Error('release response too large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}
