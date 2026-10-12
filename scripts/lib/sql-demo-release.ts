import type { SqlPublicContentResult } from './sql-public-content.js';

const parse5Url = new URL('../../web/node_modules/parse5/dist/index.js', import.meta.url);
const { parseFragment } = await import(parse5Url.href);

export interface SqlDemoPageDto {
  title: string;
  slug: string;
  body: string;
  legacy_id: string;
  seo?: { seo_title?: string; seo_description?: string };
}

export interface SqlDemoTargetLocation {
  sourceTable: 'OrganizationInfo' | 'InstituteAdditionalInfo' | 'FileBindingOrganizationInfo';
  sourceId: number;
  targetCollection: 'pages' | 'institutes';
  targetLegacyId: string;
  targetField: 'body' | 'description';
  sectionKey: string;
  anchor?: string;
  publicDocumentPath?: string;
}

export interface SqlDemoAcceptedSupplements {
  acceptedCorpus: { revision: string; sha256: string };
  pages: {
    sourcePath: string;
    revision: string;
    sha256: string;
    page: SqlDemoPageDto;
  }[];
  instituteMetadata: {
    sourceId: number;
    slug: string;
    order: number;
    seo?: { seo_title?: string; seo_description?: string };
  }[];
  videoPlaylists: {
    sourceId: number;
    sourcePath: string;
    revision: string;
    sha256: string;
    slug: string;
    legacy_id: string;
    seo?: { seo_title?: string; seo_description?: string };
    videos: unknown[] | null;
    thumbnailSourceFileId: string;
    thumbnailSourceUrl: string;
    thumbnailPublicUrl: string;
  }[];
  targetLocations: SqlDemoTargetLocation[];
}

export interface SqlDemoVerifiedAssetMapping {
  sourceFileId: string;
  sourceUrl: string;
  targetPublicUrl: string;
  sha256: string;
  detectedMimeType: string;
  verification: {
    status: 'verified';
    loader: 'sql-demo-asset-loader';
    attestationId: string;
  };
}

export interface SqlDemoAllowlistedAssets {
  images: SqlDemoVerifiedAssetMapping[];
  documents: (SqlDemoVerifiedAssetMapping & { detectedMimeType: 'application/pdf' })[];
}

export interface SqlDemoVideoReferenceDecision {
  sourceTable: 'OrganizationInfo' | 'Seminars' | 'Articles';
  sourceId: number;
  field: 'content' | 'full_text' | 'body';
  originalURL: string;
  action: 'rutube-trailing-slash' | 'external-link';
  expectedOutput: string;
}

export interface SqlDemoOwnerDecisions {
  approvedUnlinkedArticleImages: { sourceFileId: string; sourceUrl: string; decisionId: string }[];
  videoReferences: SqlDemoVideoReferenceDecision[];
}

export interface SqlDemoRelease {
  entities: Omit<SqlPublicContentResult['entities'], 'videos'> & {
    pages: SqlDemoPageDto[];
    institutes: (SqlPublicContentResult['entities']['institutes'][number] & {
      order: number;
      seo?: { seo_title?: string; seo_description?: string };
    })[];
    videos: (Omit<NonNullable<SqlPublicContentResult['entities']['videos']>[number], 'sourceId' | 'slug' | 'legacy_id' | 'title'> & {
      name: string;
      slug: string;
      legacy_id: string;
      videos: unknown[] | null;
      seo?: { seo_title?: string; seo_description?: string };
    })[];
  };
  provenance: SqlPublicContentResult['provenance'] & {
    acceptedCorpus: SqlDemoAcceptedSupplements['acceptedCorpus'];
    supplements: { sourcePath: string; revision: string; sha256: string }[];
    targetLocations: SqlDemoTargetLocation[];
    assetMappings: SqlDemoVerifiedAssetMapping[];
    videoSupplements: Pick<SqlDemoAcceptedSupplements['videoPlaylists'][number], 'sourceId' | 'sourcePath' | 'revision' | 'sha256' | 'thumbnailSourceFileId' | 'thumbnailSourceUrl' | 'thumbnailPublicUrl'>[];
    ownerDecisions: {
      approvedUnlinkedArticleImages: SqlDemoOwnerDecisions['approvedUnlinkedArticleImages'];
      videoReferences: SqlDemoVideoReferenceDecision[];
    };
  };
}

export function composeSqlDemoRelease(
  mapped: SqlPublicContentResult,
  acceptedSupplements: SqlDemoAcceptedSupplements,
  allowlistedAssets: SqlDemoAllowlistedAssets,
  ownerDecisions: SqlDemoOwnerDecisions,
): SqlDemoRelease {
  const clone = <T>(value: T): T => structuredClone(value);
  const fail = (identity: string, detail: string): never => {
    throw new Error(`Invalid SQL demo release ${identity}: ${detail}`);
  };
  const required = <T>(value: T | undefined | null, identity: string, detail: string): T =>
    value === undefined || value === null ? fail(identity, detail) : value;
  const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
  const requiredString = (value: unknown, identity: string, detail: string): string =>
    isNonEmptyString(value) ? value : fail(identity, detail);
  const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value);

  type HtmlNode = {
    nodeName: string;
    tagName?: string;
    value?: string;
    attrs?: { name: string; value: string }[];
    childNodes?: HtmlNode[];
    sourceCodeLocation?: {
      startOffset: number;
      endOffset: number;
      startTag?: { endOffset: number };
      endTag?: { startOffset: number };
    };
  };
  const attr = (node: HtmlNode, name: string): string | undefined =>
    node.attrs?.find((item) => item.name === name)?.value;
  const walk = function* (node: HtmlNode): Generator<HtmlNode> {
    for (const child of node.childNodes ?? []) {
      yield child;
      yield* walk(child);
    }
  };
  const textContent = (node: HtmlNode): string => {
    if (node.nodeName === '#text') return node.value ?? '';
    return (node.childNodes ?? []).map(textContent).join('');
  };
  const all = (node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] =>
    [...walk(node)].filter(predicate);
  const radixPanels = (root: HtmlNode): HtmlNode[] => all(root, (node) => node.tagName === 'div'
    && Boolean(node.attrs?.some((item) => item.name === 'data-state'))
    && all(node, (child) => child.tagName === 'button' && (attr(child, 'class') ?? '').includes('collapsible_trigger')).length > 0
    && all(node, (child) => Boolean(child.attrs?.some((item) => item.name === 'data-collapsible-title' && item.value === 'true'))).length > 0)
    .filter((node) => !all(node, (child) => child.tagName === 'div'
      && Boolean(child.attrs?.some((item) => item.name === 'data-state'))
      && all(child, (nested) => nested.tagName === 'button' && (attr(nested, 'class') ?? '').includes('collapsible_trigger')).length > 0
      && all(child, (nested) => Boolean(nested.attrs?.some((item) => item.name === 'data-collapsible-title' && item.value === 'true'))).length > 0).length)
    .sort((left, right) => (left.sourceCodeLocation?.startOffset ?? 0) - (right.sourceCodeLocation?.startOffset ?? 0));
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const sourceIdOf = (row: unknown, identity: string): number => {
    const id = asRecord(row).sourceId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) fail(identity, 'sourceId must be a positive integer');
    return Number(id);
  };
  const uniqueBy = <T>(rows: T[], keyOf: (row: T) => string, identity: (row: T) => string): Map<string, T> => {
    const result = new Map<string, T>();
    for (const row of rows) {
      const key = keyOf(row);
      if (result.has(key)) fail(identity(row), 'duplicate identity');
      result.set(key, row);
    }
    return result;
  };
  const locationKey = (table: SqlDemoTargetLocation['sourceTable'], id: number): string => `${table}#${id}`;
  const anchorNumber = (location: SqlDemoTargetLocation): number => {
    const match = /^section-([1-9]\d*)$/.exec(location.anchor ?? '');
    const position = match?.[1];
    if (!position) fail(locationKey(location.sourceTable, location.sourceId), 'target anchor must be a positional section-N anchor');
    return Number(position);
  };
  const escapeHtml = (value: string): string => value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

  if (!isNonEmptyString(acceptedSupplements.acceptedCorpus.revision) || !isSha256(acceptedSupplements.acceptedCorpus.sha256)) {
    fail('acceptedCorpus', 'revision and SHA-256 are required');
  }

  uniqueBy(
    acceptedSupplements.pages,
    (entry) => entry.page.slug,
    (entry) => `pages slug ${entry.page.slug || '(missing slug)'}`,
  );
  const pageLegacyIds = new Set<string>();
  for (const entry of acceptedSupplements.pages) {
    const { page: item, sourcePath, revision, sha256 } = entry;
    if (!isNonEmptyString(item.slug) || !isNonEmptyString(item.legacy_id)) fail(`pages#${item.slug || '(missing slug)'}`, 'slug and legacy_id are required');
    if (pageLegacyIds.has(item.legacy_id)) fail(`pages#${item.slug}`, `duplicate legacy_id ${item.legacy_id}`);
    pageLegacyIds.add(item.legacy_id);
    if (!isNonEmptyString(sourcePath) || revision !== acceptedSupplements.acceptedCorpus.revision || sha256 !== acceptedSupplements.acceptedCorpus.sha256) {
      fail(`pages#${item.slug}`, 'supplement is not pinned to the accepted corpus');
    }
    if (!isNonEmptyString(item.title) || typeof item.body !== 'string') fail(`pages#${item.slug}`, 'title and body are required');
  }

  const institutesBySourceId = uniqueBy(
    mapped.entities.institutes,
    (row) => String(sourceIdOf(row, 'Institutes')),
    (row) => `Institutes#${sourceIdOf(row, 'Institutes')}`,
  );
  const metadataBySourceId = uniqueBy(
    acceptedSupplements.instituteMetadata,
    (row) => String(row.sourceId),
    (row) => `InstituteMetadata#${row.sourceId}`,
  );
  if (metadataBySourceId.size !== institutesBySourceId.size) {
    const missing = [...institutesBySourceId.keys()].find((id) => !metadataBySourceId.has(id));
    const extra = [...metadataBySourceId.keys()].find((id) => !institutesBySourceId.has(id));
    fail(`InstituteMetadata#${missing ?? extra ?? 'unknown'}`, 'metadata must join every SQL institute exactly once');
  }
  const institutes = mapped.entities.institutes.map((institute) => {
    const id = sourceIdOf(institute, 'Institutes');
    const metadata = required(metadataBySourceId.get(String(id)), `InstituteMetadata#${id}`, 'metadata is missing');
    if (metadata.slug !== institute.slug) fail(`InstituteMetadata#${id}`, 'accepted slug does not match SQL institute identity');
    if (!Number.isFinite(metadata.order)) fail(`InstituteMetadata#${id}`, 'order must be numeric');
    return {
      ...clone(institute), order: metadata.order,
      ...(metadata.seo ? { seo: clone(metadata.seo) } : {}),
    };
  });

  const locationsByKey = uniqueBy(
    acceptedSupplements.targetLocations,
    (location) => locationKey(location.sourceTable, location.sourceId),
    (location) => locationKey(location.sourceTable, location.sourceId),
  );
  for (const location of acceptedSupplements.targetLocations) {
    if (!isNonEmptyString(location.sectionKey)) fail(locationKey(location.sourceTable, location.sourceId), 'sectionKey is required');
    if (!Number.isSafeInteger(location.sourceId) || location.sourceId <= 0) fail(locationKey(location.sourceTable, location.sourceId), 'sourceId must be a positive integer');
  }
  const requireLocation = (
    table: SqlDemoTargetLocation['sourceTable'], id: number,
    targetCollection: SqlDemoTargetLocation['targetCollection'], targetField: SqlDemoTargetLocation['targetField'],
  ): SqlDemoTargetLocation => {
    const identity = locationKey(table, id);
    const location = required(locationsByKey.get(identity), identity, 'missing target location');
    if (location.targetCollection !== targetCollection || location.targetField !== targetField || !isNonEmptyString(location.targetLegacyId)) {
      fail(identity, `target must be ${targetCollection}.${targetField} with a legacy identity`);
    }
    return location;
  };

  const organizations = mapped.entities.organizationInfo ?? [];
  const documents = mapped.entities.documents ?? [];
  const instituteAdditionalInfo = mapped.entities.instituteAdditionalInfo ?? [];
  const organizationLocations = new Map<number, SqlDemoTargetLocation>();
  const pageBodyByLegacyId = new Map(acceptedSupplements.pages.map((entry) => [entry.page.legacy_id, entry.page.body]));
  const panelReplacementsByLegacyId = new Map<string, { location: SqlDemoTargetLocation; html: string }[]>();
  if (organizations.length > 0) {
    const expected = new Set(organizations.map((row) => sourceIdOf(row, 'OrganizationInfo')));
    for (const row of organizations) {
      const id = sourceIdOf(row, 'OrganizationInfo');
      const location = requireLocation('OrganizationInfo', id, 'pages', 'body');
      anchorNumber(location);
      if (!pageBodyByLegacyId.has(location.targetLegacyId)) fail(`OrganizationInfo#${id}`, `target page ${location.targetLegacyId} is unresolved`);
      organizationLocations.set(id, location);
      const entries = panelReplacementsByLegacyId.get(location.targetLegacyId) ?? [];
      entries.push({ location, html: typeof row.content === 'string' ? row.content : '' });
      panelReplacementsByLegacyId.set(location.targetLegacyId, entries);
    }
    for (const location of acceptedSupplements.targetLocations.filter((item) => item.sourceTable === 'OrganizationInfo')) {
      if (!expected.has(location.sourceId)) fail(locationKey(location.sourceTable, location.sourceId), 'unused target location');
    }
  }

  const additionalByInstitute = new Map<string, string[]>();
  if (instituteAdditionalInfo.length > 0) {
    const expected = new Set<number>();
    const anchorByInstitute = new Map<string, Set<string>>();
    for (const row of instituteAdditionalInfo) {
      const id = sourceIdOf(row, 'InstituteAdditionalInfo');
      expected.add(id);
      const location = requireLocation('InstituteAdditionalInfo', id, 'institutes', 'description');
      const source = required(institutesBySourceId.get(String(row.instituteId)), `InstituteAdditionalInfo#${id}`, 'instituteId does not resolve to a mapped institute');
      if (source.legacy_id !== location.targetLegacyId) fail(`InstituteAdditionalInfo#${id}`, 'target does not match instituteId');
      const sectionName = requiredString(row.name, `InstituteAdditionalInfo#${id}`, 'named section requires a non-empty name');
      const anchor = requiredString(location.anchor, `InstituteAdditionalInfo#${id}`, 'institute section anchor is required');
      if (!/^institute-section-[1-9]\d*$/.test(anchor)) fail(`InstituteAdditionalInfo#${id}`, 'institute section anchor is required');
      const anchors = anchorByInstitute.get(source.legacy_id) ?? new Set<string>();
      if (anchors.has(anchor)) fail(`InstituteAdditionalInfo#${id}`, `duplicate target anchor ${anchor}`);
      anchors.add(anchor);
      anchorByInstitute.set(source.legacy_id, anchors);
      const section = `<section id="${escapeHtml(anchor)}"><h2>${escapeHtml(sectionName)}</h2>${typeof row.description === 'string' ? row.description : ''}</section>`;
      const entries = additionalByInstitute.get(source.legacy_id) ?? [];
      entries.push(section);
      additionalByInstitute.set(source.legacy_id, entries);
    }
    for (const location of acceptedSupplements.targetLocations.filter((item) => item.sourceTable === 'InstituteAdditionalInfo')) {
      if (!expected.has(location.sourceId)) fail(locationKey(location.sourceTable, location.sourceId), 'unused target location');
    }
  }

  const imageMappings = uniqueBy(
    allowlistedAssets.images,
    (item) => item.sourceFileId,
    (item) => `Files#${item.sourceFileId}`,
  );
  const documentMappings = uniqueBy(
    allowlistedAssets.documents,
    (item) => item.sourceFileId,
    (item) => `Files#${item.sourceFileId}`,
  );
  const verifyAsset = (asset: SqlDemoVerifiedAssetMapping, identity: string): void => {
    if (!isNonEmptyString(asset.sourceFileId) || !isNonEmptyString(asset.sourceUrl) || !isNonEmptyString(asset.targetPublicUrl)) {
      fail(identity, 'asset source and public identities are required');
    }
    if (!isSha256(asset.sha256)) fail(identity, 'asset SHA-256 is invalid');
    if (!isNonEmptyString(asset.detectedMimeType)) fail(identity, 'detected MIME type is required');
    if (asset.verification?.status !== 'verified' || asset.verification.loader !== 'sql-demo-asset-loader' || !isNonEmptyString(asset.verification.attestationId)) {
      fail(identity, 'loader attestation is required');
    }
  };
  for (const asset of allowlistedAssets.images) {
    verifyAsset(asset, `Files#${asset.sourceFileId}`);
    if (!asset.detectedMimeType.startsWith('image/')) fail(`Files#${asset.sourceFileId}`, 'detected MIME type must be an image');
  }
  for (const asset of allowlistedAssets.documents) {
    verifyAsset(asset, `Files#${asset.sourceFileId}`);
    if (asset.detectedMimeType !== 'application/pdf') fail(`Files#${asset.sourceFileId}`, 'detected MIME type must be application/pdf');
  }

  const videoRows = mapped.entities.videos ?? [];
  const sqlVideosById = uniqueBy(videoRows, (row) => String(sourceIdOf(row, 'Videos')), (row) => `Videos#${sourceIdOf(row, 'Videos')}`);
  const videoSupplementsBySourceId = uniqueBy(
    acceptedSupplements.videoPlaylists,
    (entry) => String(entry.sourceId),
    (entry) => `Videos#${entry.sourceId}`,
  );
  if (sqlVideosById.size !== videoSupplementsBySourceId.size) {
    const missing = [...sqlVideosById.keys()].find((id) => !videoSupplementsBySourceId.has(id));
    const extra = [...videoSupplementsBySourceId.keys()].find((id) => !sqlVideosById.has(id));
    fail(`Videos#${missing ?? extra ?? 'unknown'}`, 'SQL playlist and accepted supplement must join exactly once');
  }

  const usedImageIds = new Set<string>();
  const articleImageIds = new Set<string>();
  const imageBearingCollections: [string, unknown[]][] = [
    ['Institutes', mapped.entities.institutes], ['Programs', mapped.entities.programs], ['Teachers', mapped.entities.teachers],
    ['Events', mapped.entities.events], ['Articles', mapped.entities.articles], ['News', mapped.entities.news ?? []],
    ['Promotions', mapped.entities.promotions ?? []],
  ];
  for (const [table, rows] of imageBearingCollections) {
    for (const row of rows) {
      const record = asRecord(row);
      if (!isNonEmptyString(record.imageId)) continue;
      const id = sourceIdOf(row, table);
      const image = required(imageMappings.get(record.imageId), `${table}#${id}`, `imageId ${record.imageId} has no exact asset mapping`);
      if (table === 'Articles' && !ownerDecisions.approvedUnlinkedArticleImages.some((decision) =>
        decision.sourceFileId === image.sourceFileId && decision.sourceUrl === image.sourceUrl && isNonEmptyString(decision.decisionId))) {
        fail(`Files#${image.sourceFileId}`, 'source-referenced article image requires an exact owner decision');
      }
      usedImageIds.add(image.sourceFileId);
      if (table === 'Articles') articleImageIds.add(image.sourceFileId);
    }
  }
  for (const supplement of acceptedSupplements.videoPlaylists) {
    if (!isNonEmptyString(supplement.sourcePath) || !isNonEmptyString(supplement.revision) || !isSha256(supplement.sha256)) {
      fail(`Videos#${supplement.sourceId}`, 'video supplement provenance is incomplete');
    }
    const thumb = required(imageMappings.get(supplement.thumbnailSourceFileId), `Videos#${supplement.sourceId}`, `thumbnail ${supplement.thumbnailSourceFileId} has no exact image mapping`);
    if (thumb.sourceUrl !== supplement.thumbnailSourceUrl || thumb.targetPublicUrl !== supplement.thumbnailPublicUrl) {
      fail(`Videos#${supplement.sourceId}`, `thumbnail ${supplement.thumbnailSourceFileId} does not match accepted source and public URLs`);
    }
    usedImageIds.add(thumb.sourceFileId);
  }

  const ownerDecisionByImageId = uniqueBy(
    ownerDecisions.approvedUnlinkedArticleImages,
    (decision) => decision.sourceFileId,
    (decision) => `Files#${decision.sourceFileId}`,
  );
  for (const decision of ownerDecisions.approvedUnlinkedArticleImages) {
    const image = imageMappings.get(decision.sourceFileId);
    if (!image || image.sourceUrl !== decision.sourceUrl || !isNonEmptyString(decision.decisionId)) {
      fail(`Files#${decision.sourceFileId}`, 'owner decision does not match an exact image asset mapping');
    }
  }
  for (const image of allowlistedAssets.images) {
    if (!usedImageIds.has(image.sourceFileId) && !ownerDecisionByImageId.has(image.sourceFileId)) {
      fail(`Files#${image.sourceFileId}`, 'unlinked image requires an owner decision');
    }
  }
  for (const sourceFileId of articleImageIds) {
    if (!ownerDecisionByImageId.has(sourceFileId)) fail(`Files#${sourceFileId}`, 'source-referenced article image requires an owner decision');
  }
  for (const decision of ownerDecisions.approvedUnlinkedArticleImages) {
    if (usedImageIds.has(decision.sourceFileId) && !articleImageIds.has(decision.sourceFileId)) {
      fail(`Files#${decision.sourceFileId}`, 'owner decision is not for an unlinked or article image');
    }
  }

  const usedDocumentIds = new Set<string>();
  const fileLocationEntries = acceptedSupplements.targetLocations.filter((item) => item.sourceTable === 'FileBindingOrganizationInfo');
  if (documents.length > 0) {
    const expected = new Set<number>();
    for (const document of documents) {
      const id = document.bindingSourceId;
      expected.add(id);
      const location = requireLocation('FileBindingOrganizationInfo', id, 'pages', 'body');
      const orgLocation = required(organizationLocations.get(document.organizationInfoSourceId), `FileBindingOrganizationInfo#${id}`, `OrganizationInfo#${document.organizationInfoSourceId} target is unresolved`);
      if (location.targetLegacyId !== orgLocation.targetLegacyId || location.anchor !== orgLocation.anchor || location.sectionKey !== orgLocation.sectionKey) {
        fail(`FileBindingOrganizationInfo#${id}`, 'document target does not match its OrganizationInfo section');
      }
      if (!isNonEmptyString(location.publicDocumentPath)) fail(`FileBindingOrganizationInfo#${id}`, 'publicDocumentPath is required');
      const asset = required(documentMappings.get(document.fileId), `FileBindingOrganizationInfo#${id}`, `fileId ${document.fileId} has no exact PDF asset mapping`);
      if (asset.sourceUrl !== document.url) fail(`Files#${document.fileId}`, 'sourceUrl does not match SQL document URL');
      if (asset.detectedMimeType !== 'application/pdf') fail(`Files#${document.fileId}`, 'detected MIME type must be application/pdf');
      if (asset.targetPublicUrl !== location.publicDocumentPath) fail(`FileBindingOrganizationInfo#${id}`, 'publicDocumentPath does not match the PDF asset mapping');
      usedDocumentIds.add(document.fileId);
    }
    for (const location of fileLocationEntries) {
      if (!expected.has(location.sourceId)) fail(locationKey(location.sourceTable, location.sourceId), 'unused target location');
    }
    for (const asset of allowlistedAssets.documents) {
      if (!usedDocumentIds.has(asset.sourceFileId)) fail(`Files#${asset.sourceFileId}`, 'PDF asset mapping has no exact SQL document join');
    }
  }

  const videos = videoRows.map((video) => {
    const id = sourceIdOf(video, 'Videos');
    const supplement = required(videoSupplementsBySourceId.get(String(id)), `Videos#${id}`, 'accepted video supplement is missing');
    if (supplement.slug !== video.slug || supplement.legacy_id !== video.legacy_id) {
      fail(`Videos#${id}`, 'accepted slug/legacy identity does not match SQL');
    }
    const name = requiredString(video.title, `Videos#${id}`, 'SQL title is required');
    return {
      name,
      slug: video.slug,
      legacy_id: video.legacy_id,
      videos: clone(supplement.videos),
      ...(supplement.seo ? { seo: clone(supplement.seo) } : {}),
    };
  });

  const videoDecisionKey = (decision: SqlDemoVideoReferenceDecision): string =>
    `${decision.sourceTable}#${decision.sourceId}.${decision.field}\0${decision.originalURL}`;
  const videoDecisionByKey = uniqueBy(ownerDecisions.videoReferences, videoDecisionKey, (decision) => `${decision.sourceTable}#${decision.sourceId}`);
  const usedVideoDecisionKeys = new Set<string>();
  const validateVideoDecision = (decision: SqlDemoVideoReferenceDecision): void => {
    if (!isNonEmptyString(decision.originalURL) || !isNonEmptyString(decision.expectedOutput)) fail(`${decision.sourceTable}#${decision.sourceId}`, 'video decision URL and output are required');
    let url: URL;
    try { url = new URL(decision.originalURL); } catch { return fail(`${decision.sourceTable}#${decision.sourceId}`, 'video decision URL is invalid'); }
    const rutubePath = /^\/play\/embed\/[\da-f-]{36}\/?$/i.test(url.pathname);
    if (decision.action === 'rutube-trailing-slash') {
      if (url.protocol !== 'https:' || url.hostname !== 'rutube.ru' || !rutubePath || url.search || url.hash || url.pathname.endsWith('/')) {
        fail(`${decision.sourceTable}#${decision.sourceId}`, 'Rutube slash decision is outside the exact no-query embed shape');
      }
      if (decision.expectedOutput !== `<iframe src="${decision.originalURL}/">`) fail(`${decision.sourceTable}#${decision.sourceId}`, 'Rutube output does not match the approved trailing-slash transform');
      return;
    }
    if (decision.action !== 'external-link' || url.protocol !== 'https:' || url.hash) fail(`${decision.sourceTable}#${decision.sourceId}`, 'unsupported video decision action or URL');
    const rutubeQuery = url.hostname === 'rutube.ru' && /^\/play\/embed\/[\da-f-]{36}\/$/i.test(url.pathname) && url.searchParams.has('p');
    const vkEmbed = url.hostname === 'vk.com' && url.pathname === '/video_ext.php' && url.searchParams.has('oid') && url.searchParams.has('vid') && url.searchParams.has('hash');
    if (!rutubeQuery && !vkEmbed) fail(`${decision.sourceTable}#${decision.sourceId}`, 'external-link decision is outside the approved Rutube/VK embed shape');
    const expected = `<a href="${decision.originalURL}" rel="noopener noreferrer">Открыть видео</a>`;
    if (decision.expectedOutput !== expected) fail(`${decision.sourceTable}#${decision.sourceId}`, 'external-link output does not preserve the approved URL');
  };
  for (const decision of ownerDecisions.videoReferences) validateVideoDecision(decision);

  const transformVideoIframes = (
    html: string, sourceTable: SqlDemoVideoReferenceDecision['sourceTable'], sourceId: number, field: SqlDemoVideoReferenceDecision['field'],
  ): string => {
    const fragment = parseFragment(html, { sourceCodeLocationInfo: true }) as HtmlNode;
    const replacements: { start: number; end: number; value: string }[] = [];
    for (const iframe of all(fragment, (node) => node.tagName === 'iframe')) {
      const location = iframe.sourceCodeLocation;
      const originalURL = attr(iframe, 'src');
      if (!location || !Number.isSafeInteger(location.startOffset) || !Number.isSafeInteger(location.endOffset) || !originalURL) {
        fail(`${sourceTable}#${sourceId}`, `unmatched iframe in ${field}`);
      }
      const iframeLocation = required(location, `${sourceTable}#${sourceId}`, `unmatched iframe in ${field}`);
      const key = `${sourceTable}#${sourceId}.${field}\0${originalURL}`;
      const decision = required(videoDecisionByKey.get(key), `${sourceTable}#${sourceId}`, `unmatched iframe in ${field}: ${originalURL}`);
      if (usedVideoDecisionKeys.has(key)) fail(`${sourceTable}#${sourceId}`, `video decision matched more than one iframe in ${field}`);
      usedVideoDecisionKeys.add(key);
      replacements.push({ start: iframeLocation.startOffset, end: iframeLocation.endOffset, value: decision.expectedOutput });
    }
    return replacements.sort((left, right) => right.start - left.start).reduce(
      (result, replacement) => `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`,
      html,
    );
  };

  const articles = mapped.entities.articles.map((row) => ({
    ...clone(row), body: transformVideoIframes(String(row.body ?? ''), 'Articles', row.sourceId, 'body'),
  }));
  const seminars = mapped.entities.seminars.map((row) => ({
    ...clone(row), full_text: transformVideoIframes(String(row.full_text ?? ''), 'Seminars', row.sourceId, 'full_text'),
  }));
  const transformedOrganizations = organizations.map((row) => ({
    ...clone(row), content: transformVideoIframes(String(row.content ?? ''), 'OrganizationInfo', row.sourceId, 'content'),
  }));
  for (const decision of ownerDecisions.videoReferences) {
    const key = videoDecisionKey(decision);
    if (!usedVideoDecisionKeys.has(key)) fail(`${decision.sourceTable}#${decision.sourceId}`, `video decision did not match a source iframe in ${decision.field}`);
  }

  const panelRowsById = new Map(transformedOrganizations.map((row) => [row.sourceId, row]));
  const documentRowsBySection = new Map<number, NonNullable<SqlPublicContentResult['entities']['documents']>[number][]>();
  for (const document of [...documents].sort((left, right) => left.priority - right.priority || left.bindingSourceId - right.bindingSourceId)) {
    const rows = documentRowsBySection.get(document.organizationInfoSourceId) ?? [];
    rows.push(document);
    documentRowsBySection.set(document.organizationInfoSourceId, rows);
  }
  for (const [legacyId, replacements] of panelReplacementsByLegacyId) {
    let pageBody = required(pageBodyByLegacyId.get(legacyId), `pages#${legacyId}`, 'target page body is missing');
    const originalFragment = parseFragment(pageBody, { sourceCodeLocationInfo: true }) as HtmlNode;
    const originalPanels = radixPanels(originalFragment);
    const mappedItems: { id: number; position: number; item: HtmlNode; list: HtmlNode }[] = [];
    for (const { location } of replacements) {
      const id = location.sourceId;
      const row = required(panelRowsById.get(id), `OrganizationInfo#${id}`, 'SQL section is missing');
      const wantedTitle = String(asRecord(row).name ?? '').replace(/\s+/g, ' ').trim();
      const matches = originalPanels.filter((panel) => {
        const title = all(panel, (node) => Boolean(node.attrs?.some((item) => item.name === 'data-collapsible-title' && item.value === 'true')))[0];
        return title && textContent(title).replace(/\s+/g, ' ').trim() === wantedTitle;
      });
      if (matches.length !== 1) fail(`OrganizationInfo#${id}`, 'accepted Radix panel title is missing or duplicated');
      const panel = matches[0];
      const panelLocation = required(panel.sourceCodeLocation, `OrganizationInfo#${id}`, 'accepted Radix panel source boundary is unresolved');
      const listItems = all(originalFragment, (node) => node.tagName === 'li'
        && (node.sourceCodeLocation?.startOffset ?? Number.POSITIVE_INFINITY) <= panelLocation.startOffset
        && (node.sourceCodeLocation?.endOffset ?? Number.NEGATIVE_INFINITY) >= panelLocation.endOffset)
        .sort((left, right) => (left.sourceCodeLocation!.endOffset - left.sourceCodeLocation!.startOffset)
          - (right.sourceCodeLocation!.endOffset - right.sourceCodeLocation!.startOffset));
      const item = listItems[0];
      if (!item?.sourceCodeLocation) fail(`OrganizationInfo#${id}`, 'accepted Radix panel is not inside an li section');
      const lists = all(originalFragment, (node) => (node.tagName === 'ul' || node.tagName === 'ol')
        && (node.childNodes ?? []).includes(item));
      const list = lists.sort((left, right) => (left.sourceCodeLocation?.endOffset ?? 0) - (left.sourceCodeLocation?.startOffset ?? 0)
        - ((right.sourceCodeLocation?.endOffset ?? 0) - (right.sourceCodeLocation?.startOffset ?? 0)))[0];
      if (!list?.sourceCodeLocation) fail(`OrganizationInfo#${id}`, 'accepted Radix section list boundary is unresolved');
      mappedItems.push({ id, position: anchorNumber(location), item, list });
    }
    const listNode = mappedItems[0]?.list;
    if (mappedItems.some(({ list }) => list !== listNode)) fail(`pages#${legacyId}`, 'mapped Radix sections do not share one accepted section list');
    const sectionItems = (listNode?.childNodes ?? []).filter((node) => node.tagName === 'li'
      && all(node, (child) => child.tagName === 'div' && Boolean(child.attrs?.some((item) => item.name === 'data-state'))
        && all(child, (nested) => nested.tagName === 'button' && (attr(nested, 'class') ?? '').includes('collapsible_trigger')).length > 0
        && all(child, (nested) => Boolean(nested.attrs?.some((item) => item.name === 'data-collapsible-title' && item.value === 'true'))).length > 0)) as HtmlNode[];
    if (listNode && sectionItems.length !== originalPanels.length) fail(`pages#${legacyId}`, 'positional anchors span more than the mapped accepted section list');
    const desiredItems: (HtmlNode | undefined)[] = Array.from({ length: sectionItems.length });
    const mappedItemSet = new Set(mappedItems.map(({ item }) => item));
    for (const mappedItem of mappedItems) {
      const index = mappedItem.position - 1;
      if (index < 0 || index >= desiredItems.length) fail(`OrganizationInfo#${mappedItem.id}`, `accepted anchor section-${mappedItem.position} is outside the section list`);
      if (desiredItems[index]) fail(`OrganizationInfo#${mappedItem.id}`, `accepted anchor section-${mappedItem.position} is mapped more than once`);
      desiredItems[index] = mappedItem.item;
    }
    const remainingItems = sectionItems.filter((item) => !mappedItemSet.has(item));
    for (let index = 0; index < desiredItems.length; index++) {
      if (!desiredItems[index]) desiredItems[index] = remainingItems.shift();
    }
    if (remainingItems.length || desiredItems.some((item) => !item)) fail(`pages#${legacyId}`, 'accepted positional section map is incomplete');
    const orderedItems = desiredItems as HtmlNode[];
    const currentSectionItems = sectionItems;
    if (listNode?.sourceCodeLocation?.startTag && listNode.sourceCodeLocation.endTag) {
      const ranges = currentSectionItems.map((item) => item.sourceCodeLocation!).sort((left, right) => left.startOffset - right.startOffset);
      const gaps: string[] = [];
      const listInnerStart = listNode.sourceCodeLocation.startTag.endOffset;
      const listInnerEnd = listNode.sourceCodeLocation.endTag.startOffset;
      let cursor = listInnerStart;
      for (const range of ranges) {
        gaps.push(pageBody.slice(cursor, range.startOffset));
        cursor = range.endOffset;
      }
      const suffix = pageBody.slice(cursor, listInnerEnd);
      const itemHtml = new Map(currentSectionItems.map((item) => {
        const range = item.sourceCodeLocation!;
        return [item, pageBody.slice(range.startOffset, range.endOffset)] as const;
      }));
      const currentOrder = [...currentSectionItems].sort((left, right) => left.sourceCodeLocation!.startOffset - right.sourceCodeLocation!.startOffset);
      if (orderedItems.some((item, index) => item !== currentOrder[index])) {
        const inner = `${gaps[0]}${orderedItems.map((item, index) => `${itemHtml.get(item)}${gaps[index + 1] ?? ''}`).join('')}${suffix}`;
        pageBody = `${pageBody.slice(0, listInnerStart)}${inner}${pageBody.slice(listInnerEnd)}`;
      }
    }
    const fragment = parseFragment(pageBody, { sourceCodeLocationInfo: true }) as HtmlNode;
    const panels = radixPanels(fragment);
    const occupied = new Set<number>();
    const rangeReplacements: { start: number; end: number; value: string }[] = [];
    for (const { location, html } of replacements) {
      const id = location.sourceId;
      const position = anchorNumber(location);
      const panel = panels[position - 1];
      if (!panel?.sourceCodeLocation) fail(`OrganizationInfo#${id}`, `accepted Radix panel ${location.anchor} is unresolved`);
      if (occupied.has(position)) fail(`OrganizationInfo#${id}`, `accepted Radix panel ${location.anchor} is mapped more than once`);
      occupied.add(position);
      const title = all(panel, (node) => Boolean(node.attrs?.some((item) => item.name === 'data-collapsible-title' && item.value === 'true')))[0];
      const sqlRow = panelRowsById.get(id);
      if (!title || !sqlRow || textContent(title).replace(/\s+/g, ' ').trim() !== String(asRecord(sqlRow).name ?? '').replace(/\s+/g, ' ').trim()) {
        fail(`OrganizationInfo#${id}`, `accepted Radix panel ${location.anchor} title does not match SQL`);
      }
      const contentPanels = all(panel, (node) => node.tagName === 'div' && (attr(node, 'class') ?? '').includes('collapsible_content'));
      if (contentPanels.length > 1) fail(`OrganizationInfo#${id}`, 'accepted Radix panel has multiple content containers');
      const pdfLinks = (documentRowsBySection.get(id) ?? []).map((document) => {
        const target = requireLocation('FileBindingOrganizationInfo', document.bindingSourceId, 'pages', 'body').publicDocumentPath!;
        const titleText = isNonEmptyString(document.title) ? document.title : document.originalName ?? document.fileId;
        return `<p><a href="${escapeHtml(target)}">${escapeHtml(titleText)}</a></p>`;
      });
      const body = [html.trim(), ...pdfLinks].filter((part) => part !== '').join('\n');
      if (contentPanels.length === 1) {
        const contentLocation = required(contentPanels[0].sourceCodeLocation, `OrganizationInfo#${id}`, 'accepted Radix panel content boundaries are unresolved');
        const startTag = required(contentLocation.startTag, `OrganizationInfo#${id}`, 'accepted Radix panel content boundaries are unresolved');
        const endTag = required(contentLocation.endTag, `OrganizationInfo#${id}`, 'accepted Radix panel content boundaries are unresolved');
        rangeReplacements.push({ start: startTag.endOffset, end: endTag.startOffset, value: body });
      } else if (body !== '') {
        const trigger = all(panel, (node) => node.tagName === 'button' && (attr(node, 'class') ?? '').includes('collapsible_trigger'))[0];
        const triggerLocation = required(trigger?.sourceCodeLocation, `OrganizationInfo#${id}`, 'accepted Radix panel trigger boundary is unresolved');
        rangeReplacements.push({ start: triggerLocation.endOffset, end: triggerLocation.endOffset, value: `<div class="collapsible_content">${body}</div>` });
      }
    }
    const output = rangeReplacements.sort((left, right) => right.start - left.start).reduce(
      (result, replacement) => `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`,
      pageBody,
    );
    pageBodyByLegacyId.set(legacyId, required(output, `pages#${legacyId}`, 'composed page body is missing'));
  }
  const pages = acceptedSupplements.pages.map((entry) => ({ ...clone(entry.page), body: pageBodyByLegacyId.get(entry.page.legacy_id) ?? entry.page.body }));
  const composedInstitutes = institutes.map((institute) => {
    const sections = additionalByInstitute.get(institute.legacy_id) ?? [];
    return sections.length ? { ...institute, description: [String(asRecord(institute).description ?? ''), ...sections].filter(Boolean).join('\n') } : institute;
  });
  const mappedEntities = clone(mapped.entities);
  const entities: SqlDemoRelease['entities'] = {
    ...mappedEntities,
    seminars,
    articles,
    organizationInfo: transformedOrganizations,
    pages,
    institutes: composedInstitutes,
    videos,
  };

  return {
    entities,
    provenance: {
      ...clone(mapped.provenance),
      acceptedCorpus: clone(acceptedSupplements.acceptedCorpus),
      supplements: acceptedSupplements.pages.map(({ sourcePath, revision, sha256 }) => ({ sourcePath, revision, sha256 })),
      targetLocations: clone(acceptedSupplements.targetLocations),
      assetMappings: clone([...allowlistedAssets.images, ...allowlistedAssets.documents]),
      videoSupplements: acceptedSupplements.videoPlaylists.map(({ sourceId, sourcePath, revision, sha256, thumbnailSourceFileId, thumbnailSourceUrl, thumbnailPublicUrl }) => ({
        sourceId, sourcePath, revision, sha256, thumbnailSourceFileId, thumbnailSourceUrl, thumbnailPublicUrl,
      })),
      ownerDecisions: clone(ownerDecisions),
    },
  };
}
