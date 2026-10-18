import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';
import { mergeMediaImportIdentity } from '../../../lib/media-import-identity';

interface MediaIdentityRequest {
  sourceUrl?: unknown;
  sourceSha256?: unknown;
  expectedStoredSha256?: unknown;
  adoptedFrom?: unknown;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async set(ctx: Context) {
    const fileId = Number(ctx.params.id);
    const body = ctx.request.body as MediaIdentityRequest | undefined;
    const sourceUrl = body?.sourceUrl;
    const sourceSha256 = body?.sourceSha256;
    const expectedStoredSha256 = body?.expectedStoredSha256;
    const adoptedFrom = body?.adoptedFrom;

    if (!Number.isSafeInteger(fileId) || fileId < 1) return ctx.badRequest('invalid media ID');
    if (typeof sourceUrl !== 'string' || typeof sourceSha256 !== 'string') {
      return ctx.badRequest('sourceUrl and sourceSha256 are required');
    }
    if (adoptedFrom !== undefined && typeof adoptedFrom !== 'string') {
      return ctx.badRequest('adoptedFrom must be a string');
    }
    if (expectedStoredSha256 !== undefined &&
      (typeof expectedStoredSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedStoredSha256))) {
      return ctx.badRequest('expectedStoredSha256 must be a lowercase 64-character hexadecimal digest');
    }

    const files = strapi.db.query('plugin::upload.file');
    const file = await files.findOne({
      where: { id: fileId },
      select: ['id', 'url', 'provider', 'provider_metadata'],
    }) as { id: number; url: string; provider: string; provider_metadata?: unknown } | null;
    if (!file) return ctx.notFound('media file not found');

    const configuredProvider = strapi.config.get('plugin::upload.provider', 'local');
    if (configuredProvider !== 'local' || file.provider !== 'local') {
      return ctx.badRequest('media identity fingerprints require the local upload provider');
    }
    const storedSha256 = await hashLocalUpload(strapi, file.url);
    if (expectedStoredSha256 !== undefined && expectedStoredSha256 !== storedSha256) {
      ctx.status = 409;
      ctx.body = { error: 'stored media changed since inventory was captured' };
      return;
    }

    let providerMetadata: Record<string, unknown>;
    try {
      providerMetadata = mergeMediaImportIdentity(file.provider_metadata, sourceUrl, {
        version: 1,
        sha256: sourceSha256,
        storedSha256,
        ...(typeof adoptedFrom === 'string' ? { adoptedFrom } : {}),
      });
    } catch (error: unknown) {
      return ctx.badRequest(error instanceof Error ? error.message : String(error));
    }

    await files.update({
      where: { id: fileId },
      data: { provider_metadata: providerMetadata },
    });
    ctx.body = { data: { id: fileId, storedSha256 } };
  },
});

async function hashLocalUpload(
  strapi: Core.Strapi,
  url: string,
): Promise<string> {
  const match = /^\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(url);
  if (!match) throw new Error('media URL is outside the local uploads directory');

  const uploadsDirectory = path.resolve(strapi.dirs.static.public, 'uploads');
  const [realDirectory, realFile] = await Promise.all([
    realpath(uploadsDirectory),
    realpath(path.join(uploadsDirectory, match[1])),
  ]);
  if (realFile !== path.join(realDirectory, match[1])) {
    throw new Error('media file resolves outside the local uploads directory');
  }
  return createHash('sha256').update(await readFile(realFile)).digest('hex');
}
