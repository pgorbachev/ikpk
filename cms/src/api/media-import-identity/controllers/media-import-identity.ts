import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';
import { mergeMediaImportIdentity } from '../../../lib/media-import-identity';

interface MediaIdentityRequest {
  sourceUrl?: unknown;
  sourceSha256?: unknown;
  adoptedFrom?: unknown;
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async set(ctx: Context) {
    const fileId = Number(ctx.params.id);
    const body = ctx.request.body as MediaIdentityRequest | undefined;
    const sourceUrl = body?.sourceUrl;
    const sourceSha256 = body?.sourceSha256;
    const adoptedFrom = body?.adoptedFrom;

    if (!Number.isSafeInteger(fileId) || fileId < 1) return ctx.badRequest('invalid media ID');
    if (typeof sourceUrl !== 'string' || typeof sourceSha256 !== 'string') {
      return ctx.badRequest('sourceUrl and sourceSha256 are required');
    }
    if (adoptedFrom !== undefined && typeof adoptedFrom !== 'string') {
      return ctx.badRequest('adoptedFrom must be a string');
    }

    const files = strapi.db.query('plugin::upload.file');
    const file = await files.findOne({
      where: { id: fileId },
      select: ['id', 'provider_metadata'],
    }) as { id: number; provider_metadata?: unknown } | null;
    if (!file) return ctx.notFound('media file not found');

    let providerMetadata: Record<string, unknown>;
    try {
      providerMetadata = mergeMediaImportIdentity(file.provider_metadata, sourceUrl, {
        sha256: sourceSha256,
        ...(typeof adoptedFrom === 'string' ? { adoptedFrom } : {}),
      });
    } catch (error: unknown) {
      return ctx.badRequest(error instanceof Error ? error.message : String(error));
    }

    await files.update({
      where: { id: fileId },
      data: { provider_metadata: providerMetadata },
    });
    ctx.body = { data: { id: fileId } };
  },
});
