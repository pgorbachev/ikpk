import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseFragment } from 'parse5';
import { readVerifiedOfflineImageSource } from './import-media.js';
import { resolveSqlImageFile } from './sql-demo-image-identity.js';

type SqlHeaderImageRow = { id: number; status?: string; imageId: string | null };

export interface SqlDemoAssetSource {
  sourceHash: string;
  Institutes?: SqlHeaderImageRow[];
  Programs?: (SqlHeaderImageRow & { content?: string | null })[];
  Teachers?: SqlHeaderImageRow[];
  Events?: SqlHeaderImageRow[];
  Files?: {
    id: string; fileType: string | null; originalName: string | null; extension: string | null;
    url: string | null; status: string; privacy: string;
  }[];
  FileBindingOrganizationInfo?: { id: number; fileId: string; organizationInfoId: number }[];
  OrganizationInfo?: { id: number; status: string }[];
  Articles?: { id: number; status: string; imageId: string | null; content: string | null }[];
  Videos?: { id: number; status: string; imageId: string | null; link: string | null }[];
  Seminars?: { id: number; status: string; learningProcess?: string | null }[];
  News?: SqlHeaderImageRow[];
  Promotions?: SqlHeaderImageRow[];
}

export type SqlDemoSelectedPublicHeaderReference = {
  sourceTable: 'Institutes' | 'Programs' | 'Teachers' | 'Events' | 'Articles' | 'News' | 'Promotions' | 'Videos';
  sourceId: number;
  imageId: string;
};

export interface SqlDemoSelectedPublicHeaders {
  /** Hash of the same pinned SQL snapshot used by the public-content mapper. */
  sourceHash: string;
  references: SqlDemoSelectedPublicHeaderReference[];
}

export type SqlDemoAssetReachability =
  | { kind: 'sql-header' }
  | { kind: 'article-body'; articleSourceIds: number[] }
  | { kind: 'public-rich-text'; references: { sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess' }[] }
  | { kind: 'video-thumbnail'; videoSourceId: number }
  | { kind: 'document-binding'; bindingSourceId: number }
  | { kind: 'static-supplement'; supplementName: string };

export interface SqlDemoAssetManifestEntry {
  sourceFileId: string;
  archiveRelativePath: string;
  sha256: string;
  sourceFileType: 'image' | 'document';
  sourceStatus: 'active' | 'disabled' | 'unlinked';
  sourcePrivacy: 'public' | 'private';
  reachability: SqlDemoAssetReachability;
}

export interface SqlDemoAssetManifest {
  schemaVersion: 1;
  scope: 'sql-demo-public-assets';
  baselineSqlSha256: string;
  archiveSha256: string;
  entries: SqlDemoAssetManifestEntry[];
}

export type SqlDemoSupplementScope =
  | 'public-static-page'
  | 'public-video-thumbnail'
  | 'missing-original-replacement';

export interface SqlDemoSupplementEntry {
  name: string;
  scope: SqlDemoSupplementScope;
  sourcePath: string;
  revision: string;
  sha256: string;
  /** Required for a replacement; it records that this file does not restore source bytes. */
  replacesMissingSourceFileId?: string;
}

export interface SqlDemoSupplementManifest {
  schemaVersion: 1;
  scope: 'sql-demo-approved-supplements';
  sha256: string;
  codeRevision: string;
  entries: SqlDemoSupplementEntry[];
}

/** Hashes only the named, ordered manifest payload; its advertised sha256 field is excluded. */
export function computeSqlDemoSupplementManifestSha256(
  manifest: Pick<SqlDemoSupplementManifest, 'schemaVersion' | 'scope' | 'codeRevision' | 'entries'>,
): string {
  const payload = {
    schemaVersion: manifest.schemaVersion,
    scope: manifest.scope,
    codeRevision: manifest.codeRevision,
    entries: manifest.entries.map((entry) => ({
      name: entry.name,
      scope: entry.scope,
      sourcePath: entry.sourcePath,
      revision: entry.revision,
      sha256: entry.sha256,
      ...(entry.replacesMissingSourceFileId === undefined
        ? {}
        : { replacesMissingSourceFileId: entry.replacesMissingSourceFileId }),
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface SqlDemoAssetLoaderInput {
  /** Native reader/mapping output with its already-verified source digest. */
  source: SqlDemoAssetSource;
  /** Selected mapper output references; this is not an asset-manifest reachability claim. */
  selectedPublicHeaders: SqlDemoSelectedPublicHeaders;
  baseline: { sqlSha256: string; archiveSha256: string };
  assetRoot: string;
  assetManifest: SqlDemoAssetManifest;
  approvedBodyFileGrants: {
    sourceFileId: string;
    sourceSha256: string;
    decisionId: string;
  }[];
  approvedPublicRichTextGrants?: {
    sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess';
    sourceFileId: string; sourceSha256: string; decisionId: string; sourceReferenceAlias: string;
  }[];
  approvedMissingOriginalReplacements?: {
    sourceFileId: string;
    replacementPath: string;
    replacementRevision: string;
    replacementSha256: string;
    sourceBytesAvailable: false;
  }[];
  supplementRoot: string;
  supplementManifest: SqlDemoSupplementManifest;
  expectedSupplements: { codeRevision: string; manifestSha256: string };
}

/**
 * An offline proof is created only after the verifier has checked the resolved path,
 * source SHA-256 and byte magic. It is never read from input data.
 * Image verification is to reuse the shared import-media verifier; this loader does
 * not own a second raster codec. PDF validation is a separate document guard.
 */
interface SqlDemoOfflineSourceProof {
  sourceFileId: string;
  sourceUrl: string;
  archiveRelativePath: string;
  resolvedLocalPath: string;
  sourceSha256: string;
  reachability: SqlDemoAssetReachability;
  verification: {
    status: 'verified';
    loader: 'sql-demo-asset-loader';
    attestationId: string;
  };
}

interface SqlDemoOfflineRasterProof extends Omit<SqlDemoOfflineSourceProof, 'sourceSha256'> {
  sourceFileType: 'image';
  detectedMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  detectedExtension: 'png' | 'jpg' | 'webp';
}

export type SqlDemoOfflineAssetProof = (SqlDemoOfflineRasterProof & {
  /** SHA of the original selected source bytes, when those bytes were recovered. */
  sourceSha256: string;
  sourceReferenceAliases?: string[];
  substitution?: never;
}) | (SqlDemoOfflineRasterProof & {
  /** Original bytes were absent; replacement hash is never represented as sourceSha256. */
  sourceBytesAvailable: false;
  substitution: { replacementSha256: string; replacementPath: string; replacementRevision: string };
  sourceReferenceAliases?: never;
});

export interface SqlDemoOfflineDocumentProof extends SqlDemoOfflineSourceProof {
  sourceFileType: 'document';
  detectedMimeType: 'application/pdf';
  detectedExtension: 'pdf';
}

type SqlDemoAssetProvenance = {
  sourceFileType: 'image' | 'document'; sourceFileId: string; archiveRelativePath: string; sourceSha256?: string;
  reachability: SqlDemoAssetReachability; selectedPublicHeaderReferences?: SqlDemoSelectedPublicHeaderReference[];
  sourceReferenceAliases?: string[]; substitution?: { replacementSha256: string; replacementPath: string; replacementRevision: string };
  sourceBytesAvailable?: false;
};

export interface SqlDemoAssetLoaderResult {
  /** Verified local raster sources; no upload or CMS public URL is implied by this result. */
  offlineMedia: SqlDemoOfflineAssetProof[];
  /** PDF documents remain separate from raster media. */
  offlineDocuments: SqlDemoOfflineDocumentProof[];
  supplements: {
    sourcePath: string;
    revision: string;
    sha256: string;
    scope: SqlDemoSupplementScope;
    replacesMissingSourceFileId?: string;
  }[];
  provenance: {
    baseline: { sqlSha256: string; archiveSha256: string };
    assets: SqlDemoAssetProvenance[];
    supplements: SqlDemoAssetLoaderResult['supplements'];
  };
}

/**
 * Offline asset join boundary. The implementation must verify local bytes before
 * emitting this proof; callers cannot submit pre-verified mappings or CMS URLs.
 */
export async function loadSqlDemoAssets(input: SqlDemoAssetLoaderInput): Promise<SqlDemoAssetLoaderResult> {
  if (!Array.isArray(input.assetManifest.entries)) throw new Error('public asset manifest entries must be an array');
  if (!Array.isArray(input.approvedBodyFileGrants)) throw new Error('body file grants must be an array');
  assertSha256(input.baseline.sqlSha256, 'baseline SQL SHA-256');
  assertSha256(input.baseline.archiveSha256, 'baseline archive SHA-256');
  if (
    input.source.sourceHash !== input.baseline.sqlSha256 ||
    input.assetManifest.baselineSqlSha256 !== input.baseline.sqlSha256
  ) {
    throw new Error('SQL baseline SHA-256 does not match the pinned manifest');
  }
  if (input.selectedPublicHeaders.sourceHash !== input.baseline.sqlSha256) {
    throw new Error('selected public header mapper source hash does not match the pinned SQL baseline');
  }
  if (!Array.isArray(input.selectedPublicHeaders.references)) {
    throw new Error('selected public header references must be an array');
  }
  if (input.assetManifest.archiveSha256 !== input.baseline.archiveSha256) {
    throw new Error('archive inventory SHA-256 does not match the pinned baseline');
  }
  if (input.assetManifest.schemaVersion !== 1 || input.assetManifest.scope !== 'sql-demo-public-assets') {
    throw new Error('public asset manifest scope or version is invalid');
  }

  const sourceFiles = input.source.Files ?? [];
  const filesById = new Map<string, NonNullable<SqlDemoAssetSource['Files']>[number]>();
  for (const file of sourceFiles) {
    if (!file || typeof file.id !== 'string' || !file.id) {
      throw new Error('Files has a missing or invalid file identity');
    }
    if (filesById.has(file.id)) throw new Error(`Files#${file.id} has a duplicate identity`);
    filesById.set(file.id, file);
  }

  const reachability = new Map<string, {
    headers: boolean;
    headerReferences: SqlDemoSelectedPublicHeaderReference[];
    videoIds: number[];
    bindingIds: number[];
    articleIds: number[];
    richTextReferences: { sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess' }[];
    sourceReferenceAliases: string[];
  }>();
  const usageFor = (fileId: string) => {
    let usage = reachability.get(fileId);
    if (!usage) {
      usage = { headers: false, headerReferences: [], videoIds: [], bindingIds: [], articleIds: [], richTextReferences: [], sourceReferenceAliases: [] };
      reachability.set(fileId, usage);
    }
    return usage;
  };

  const selectedHeaderKeys = new Set<string>();
  for (const reference of input.selectedPublicHeaders.references) {
    if (
      !reference || !Number.isSafeInteger(reference.sourceId) || reference.sourceId <= 0 ||
      typeof reference.imageId !== 'string' || !reference.imageId ||
      !['Institutes', 'Programs', 'Teachers', 'Events', 'Articles', 'News', 'Promotions', 'Videos'].includes(reference.sourceTable)
    ) {
      throw new Error('selected public header reference has an invalid source identity');
    }
    const referenceKey = `${reference.sourceTable}#${reference.sourceId}`;
    if (selectedHeaderKeys.has(referenceKey)) {
      throw new Error(`${reference.sourceTable}#${reference.sourceId} selected header reference is duplicated`);
    }
    selectedHeaderKeys.add(referenceKey);

    const rows = input.source[reference.sourceTable] as SqlHeaderImageRow[] | undefined;
    const matches = (rows ?? []).filter((row) => row.id === reference.sourceId);
    if (matches.length !== 1) {
      throw new Error(`${reference.sourceTable}#${reference.sourceId} selected header reference does not join to one SQL source row`);
    }
    const row = matches[0]!;
    if (reference.sourceTable === 'Institutes'
      ? row.status !== undefined && row.status !== 'active'
      : row.status !== 'active') {
      throw new Error(`${reference.sourceTable}#${reference.sourceId}.status is not active for a selected header reference`);
    }
    if (row.imageId !== reference.imageId) {
      throw new Error(`${reference.sourceTable}#${reference.sourceId}.imageId differs from the selected header reference`);
    }
    const file = filesById.get(reference.imageId);
    if (!file) throw new Error(`${reference.sourceTable}#${reference.sourceId}.imageId does not join to SQL Files`);
    assertKnownFileStatus(file);
    if (file.status !== 'active') {
      throw new Error(`Files#${file.id}.status is not active for a selected public header`);
    }
    const usage = usageFor(file.id);
    usage.headers = true;
    usage.headerReferences.push({ ...reference });
  }

  const selectedVideoIds = new Set(input.selectedPublicHeaders.references
    .filter((reference) => reference.sourceTable === 'Videos')
    .map((reference) => reference.sourceId));
  for (const video of input.source.Videos ?? []) {
    if (!selectedVideoIds.has(video.id)) continue;
    if (video.status !== 'active' || video.imageId === null) continue;
    if (typeof video.imageId !== 'string' || !video.imageId) {
      throw new Error(`Videos#${video.id}.imageId is invalid`);
    }
    const file = filesById.get(video.imageId);
    if (!file) throw new Error(`Videos#${video.id}.imageId does not join to Files`);
    assertKnownFileStatus(file);
    usageFor(video.imageId).videoIds.push(video.id);
  }

  for (const binding of input.source.FileBindingOrganizationInfo ?? []) {
    if (
      !binding || !Number.isSafeInteger(binding.id) || binding.id <= 0 ||
      !Number.isSafeInteger(binding.organizationInfoId) || binding.organizationInfoId <= 0 ||
      typeof binding.fileId !== 'string' || !binding.fileId
    ) {
      throw new Error('FileBindingOrganizationInfo has an invalid binding identity');
    }
    // A binding is not a document authorization. Only files named by the
    // separate public-asset allowlist become loader reachability.
    if (!input.assetManifest.entries.some((entry) => entry?.sourceFileId === binding.fileId && entry.sourceFileType === 'document')) continue;
    const file = filesById.get(binding.fileId);
    if (!file) throw new Error(`FileBindingOrganizationInfo#${binding.id}.fileId does not join to Files`);
    assertKnownFileStatus(file);
    usageFor(binding.fileId).bindingIds.push(binding.id);
  }

  const activeOrganizationIds = new Set((input.source.OrganizationInfo ?? [])
    .filter((row) => row.status === 'active')
    .map((row) => row.id));
  const hasOrganizationInfo = input.source.OrganizationInfo !== undefined;
  if (hasOrganizationInfo) {
    for (const binding of input.source.FileBindingOrganizationInfo ?? []) {
      if (!activeOrganizationIds.has(binding.organizationInfoId)) {
        throw new Error(`FileBindingOrganizationInfo#${binding.id}.organizationInfoId is not active`);
      }
    }
  }

  for (const article of input.source.Articles ?? []) {
    if (article.status !== 'active' || !article.content) continue;
    for (const bodyUrl of imageSources(article.content)) {
      const file = resolveSqlImageFile(sourceFiles, bodyUrl, `Articles#${article.id}.content`);
      assertKnownFileStatus(file);
      const usage = usageFor(file.id);
      usage.articleIds.push(article.id);
      if (bodyUrl !== file.url) usage.sourceReferenceAliases.push(bodyUrl);
    }
  }

  const richTextGrants = input.approvedPublicRichTextGrants ?? [];
  const richTextGrantByReference = new Map<string, (typeof richTextGrants)[number]>();
  for (const grant of richTextGrants) {
    const key = `${grant.sourceTable}#${grant.sourceId}.${grant.sourceField}\0${grant.sourceFileId}`;
    if (richTextGrantByReference.has(key)) throw new Error(`Files#${grant.sourceFileId} has a duplicate public rich-text grant`);
    assertSha256(grant.sourceSha256, `Files#${grant.sourceFileId} rich-text SHA-256`);
    richTextGrantByReference.set(key, grant);
  }
  const richTextSources = [
    ...(input.source.Programs ?? []).filter((row) => row.status === 'active').map((row) => ({
      sourceTable: 'Programs' as const, sourceId: row.id, sourceField: 'content' as const, html: row.content ?? '',
    })),
    ...(input.source.Seminars ?? []).filter((row) => row.status === 'active').map((row) => ({
      sourceTable: 'Seminars' as const, sourceId: row.id, sourceField: 'learningProcess' as const, html: row.learningProcess ?? '',
    })),
  ];
  const usedRichTextGrants = new Set<string>();
  for (const source of richTextSources) {
    for (const sourceUrl of imageSources(source.html)) {
      const file = resolveSqlImageFile(sourceFiles, sourceUrl, `${source.sourceTable}#${source.sourceId}.${source.sourceField}`);
      if (file.status !== 'unlinked') continue;
      const key = `${source.sourceTable}#${source.sourceId}.${source.sourceField}\0${file.id}`;
      const grant = richTextGrantByReference.get(key);
      if (!grant || grant.sourceReferenceAlias !== sourceUrl) {
        throw new Error(`Files#${file.id} unlinked rich-text image has no exact owner grant for ${source.sourceTable}#${source.sourceId}.${source.sourceField}`);
      }
      const usage = usageFor(file.id);
      usage.richTextReferences.push({ sourceTable: source.sourceTable, sourceId: source.sourceId, sourceField: source.sourceField });
      usage.sourceReferenceAliases.push(sourceUrl);
      usedRichTextGrants.add(key);
    }
  }
  for (const key of richTextGrantByReference.keys()) {
    if (!usedRichTextGrants.has(key)) throw new Error(`public rich-text grant ${key.replace('\0', ' ')} does not match an active SQL source image`);
  }

  const grantsByFileId = new Map<string, SqlDemoAssetLoaderInput['approvedBodyFileGrants'][number]>();
  for (const grant of input.approvedBodyFileGrants) {
    if (
      !grant || typeof grant.sourceFileId !== 'string' || !grant.sourceFileId ||
      typeof grant.decisionId !== 'string' || !grant.decisionId.trim()
    ) {
      throw new Error('body file grant has an invalid identity or decision');
    }
    assertSha256(grant.sourceSha256, `body file grant Files#${grant.sourceFileId} SHA-256`);
    if (grantsByFileId.has(grant.sourceFileId)) {
      throw new Error(`body file grant for Files#${grant.sourceFileId} is duplicated`);
    }
    grantsByFileId.set(grant.sourceFileId, grant);
  }

  const entriesByFileId = new Map<string, SqlDemoAssetManifestEntry>();
  const offlineMedia: SqlDemoOfflineAssetProof[] = [];
  const offlineDocuments: SqlDemoOfflineDocumentProof[] = [];
  const provenanceAssets: SqlDemoAssetLoaderResult['provenance']['assets'] = [];
  for (const entry of input.assetManifest.entries) {
    if (!entry || typeof entry.sourceFileId !== 'string' || !entry.sourceFileId) {
      throw new Error('public asset manifest has an invalid Files identity');
    }
    if (entriesByFileId.has(entry.sourceFileId)) {
      throw new Error(`public asset manifest has duplicate Files#${entry.sourceFileId}`);
    }
    entriesByFileId.set(entry.sourceFileId, entry);
    assertSha256(entry.sha256, `Files#${entry.sourceFileId} source SHA-256`);
    const file = filesById.get(entry.sourceFileId);
    if (!file) throw new Error(`public asset manifest Files#${entry.sourceFileId} does not join to SQL Files`);
    assertKnownFileStatus(file);
    if (entry.sourceFileType !== file.fileType) {
      throw new Error(`Files#${file.id}.fileType differs from the public asset manifest`);
    }
    if (entry.sourceStatus !== file.status) {
      throw new Error(`Files#${file.id}.status differs from the public asset manifest`);
    }
    if (entry.sourcePrivacy !== file.privacy) {
      throw new Error(`Files#${file.id}.privacy differs from the public asset manifest`);
    }
    if (file.privacy !== 'public') throw new Error(`Files#${file.id}.privacy is not public`);
    if (file.status === 'disabled') throw new Error(`Files#${file.id}.status is disabled`);
    if (typeof file.url !== 'string' || !file.url) throw new Error(`Files#${file.id}.url is missing`);

    const actualUsage = reachability.get(file.id);
    if (!actualUsage) throw new Error(`Files#${file.id} has no active SQL public reachability`);
    const actualArticleIds = uniqueSorted(actualUsage.articleIds);
    const actualVideoIds = uniqueSorted(actualUsage.videoIds);
    const actualBindingIds = uniqueSorted(actualUsage.bindingIds);
    assertManifestReachability(entry, actualUsage, actualArticleIds, actualVideoIds, actualBindingIds);

    if (entry.sourceFileType === 'image') {
      if (actualBindingIds.length > 0) throw new Error(`Files#${file.id}.fileType image cannot satisfy a document binding`);
      if (file.status === 'unlinked') {
        const articleBodyOnly = actualArticleIds.length > 0 && !actualUsage.headers && !actualVideoIds.length && !actualBindingIds.length && !actualUsage.richTextReferences.length;
        const richTextOnly = actualUsage.richTextReferences.length > 0 && !actualArticleIds.length && !actualUsage.headers && !actualVideoIds.length && !actualBindingIds.length;
        if (!articleBodyOnly && !richTextOnly) throw new Error(`Files#${file.id}.status unlinked requires exact approved article-body or public rich-text reachability`);
        const grant = grantsByFileId.get(file.id);
        if (articleBodyOnly) {
          if (!grant || grant.sourceSha256 !== entry.sha256) {
            throw new Error(`Files#${file.id} active article body image requires an exact file ID and source SHA grant`);
          }
          grantsByFileId.delete(file.id);
        }
        if (richTextOnly && !richTextGrants.some((item) => item.sourceFileId === file.id && item.sourceSha256 === entry.sha256 &&
          actualUsage.richTextReferences.some((reference) => item.sourceTable === reference.sourceTable && item.sourceId === reference.sourceId && item.sourceField === reference.sourceField))) {
          throw new Error(`Files#${file.id} public rich-text image requires an exact owner file, source SHA, and field grant`);
        }
      }
      if (!actualArticleIds.length && !actualUsage.headers && !actualVideoIds.length && !actualUsage.richTextReferences.length) {
        throw new Error(`Files#${file.id} image has no supported public reachability`);
      }
      if (actualVideoIds.length > 1) {
        throw new Error(`Files#${file.id} is bound to multiple active video thumbnails`);
      }
      const sourceFilename = file.originalName || basename(entry.archiveRelativePath);
      let verified;
      try {
        verified = await readVerifiedOfflineImageSource({
          root: input.assetRoot,
          sourceIdentity: `Files#${file.id}`,
          sourcePath: entry.archiveRelativePath,
          sourceSha256: entry.sha256,
          sourceFilename,
        });
      } catch (error: unknown) {
        throw safeVerificationError(`Files#${file.id}`, error);
      }
      const expectedReachability = assetReachability(actualUsage, actualArticleIds, actualVideoIds, actualBindingIds);
      const proof: SqlDemoOfflineAssetProof = {
        sourceFileType: 'image',
        sourceFileId: file.id,
        sourceUrl: file.url,
        archiveRelativePath: entry.archiveRelativePath,
        resolvedLocalPath: verified.resolvedLocalPath,
        sourceSha256: verified.sourceSha256,
        ...(actualUsage.sourceReferenceAliases.length ? { sourceReferenceAliases: [...new Set(actualUsage.sourceReferenceAliases)].sort() } : {}),
        reachability: expectedReachability,
        verification: {
          status: 'verified',
          loader: 'sql-demo-asset-loader',
          attestationId: attestationId(file.id, file.url, entry.archiveRelativePath, verified.sourceSha256, expectedReachability, actualUsage.headerReferences, actualUsage.sourceReferenceAliases),
        },
        detectedMimeType: verified.mime as SqlDemoOfflineAssetProof['detectedMimeType'],
        detectedExtension: verified.mime === 'image/jpeg' ? 'jpg' : verified.mime === 'image/png' ? 'png' : 'webp',
      };
      offlineMedia.push(proof);
      provenanceAssets.push(pickAssetProvenance(proof, actualUsage.headerReferences));
    } else if (entry.sourceFileType === 'document') {
      if (file.status !== 'active') throw new Error(`Files#${file.id}.status must be active for public documents`);
      if (actualBindingIds.length !== 1 || actualArticleIds.length || actualUsage.headers || actualVideoIds.length) {
        throw new Error(`Files#${file.id} document requires one active FileBindingOrganizationInfo identity`);
      }
      if (actualUsage.bindingIds.length !== 1) {
        throw new Error(`Files#${file.id} document is bound by multiple FileBindingOrganizationInfo rows`);
      }
      let verified;
      try {
        verified = await readVerifiedLocalFile(
          input.assetRoot,
          entry.archiveRelativePath,
          entry.sha256,
          `Files#${file.id}`,
        );
      } catch (error: unknown) {
        throw safeVerificationError(`Files#${file.id}`, error);
      }
      if (!verified.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new Error(`Files#${file.id} document bytes do not have PDF magic`);
      }
      const expectedReachability = assetReachability(actualUsage, actualArticleIds, actualVideoIds, actualBindingIds);
      const proof: SqlDemoOfflineDocumentProof = {
        sourceFileType: 'document',
        sourceFileId: file.id,
        sourceUrl: file.url,
        archiveRelativePath: entry.archiveRelativePath,
        resolvedLocalPath: verified.resolvedLocalPath,
        sourceSha256: verified.sourceSha256,
        reachability: expectedReachability,
        verification: {
          status: 'verified',
          loader: 'sql-demo-asset-loader',
          attestationId: attestationId(file.id, file.url, entry.archiveRelativePath, verified.sourceSha256, expectedReachability),
        },
        detectedMimeType: 'application/pdf',
        detectedExtension: 'pdf',
      };
      offlineDocuments.push(proof);
      provenanceAssets.push(pickAssetProvenance(proof, actualUsage.headerReferences));
    } else {
      throw new Error(`Files#${file.id}.fileType is unsupported`);
    }
  }

  const { supplements, replacements } = await verifySupplements(input);
  const approvedReplacementIds = new Set<string>();
  for (const decision of input.approvedMissingOriginalReplacements ?? []) {
    if (!decision || typeof decision.sourceFileId !== 'string' || !decision.sourceFileId || decision.sourceBytesAvailable !== false) {
      throw new Error('missing-original replacement decision has an invalid source identity or byte-availability claim');
    }
    if (approvedReplacementIds.has(decision.sourceFileId)) throw new Error(`Files#${decision.sourceFileId} has duplicate missing-original replacement decisions`);
    approvedReplacementIds.add(decision.sourceFileId);
    const file = filesById.get(decision.sourceFileId);
    if (!file || file.fileType !== 'image' || file.status !== 'active' || file.privacy !== 'public') {
      throw new Error(`Files#${decision.sourceFileId} replacement does not join to an active public native image`);
    }
    if (typeof file.url !== 'string' || !file.url) throw new Error(`Files#${decision.sourceFileId}.url is missing for the named replacement`);
    const usage = reachability.get(decision.sourceFileId);
    const headerReferences = usage?.headerReferences ?? [];
    if (!usage?.headers || headerReferences.length !== 1 || headerReferences[0]!.sourceTable !== 'Institutes' || headerReferences[0]!.sourceId !== 3 ||
      usage.articleIds.length || usage.videoIds.length || usage.bindingIds.length || usage.richTextReferences.length || entriesByFileId.has(decision.sourceFileId)) {
      throw new Error(`Files#${decision.sourceFileId} replacement is not the exact selected Institutes#3 header with unavailable original bytes`);
    }
    const path = decision.replacementPath;
    const revision = decision.replacementRevision;
    const hash = decision.replacementSha256;
    assertGitRevision(revision, `Files#${decision.sourceFileId} replacement revision`);
    assertSha256(hash, `Files#${decision.sourceFileId} replacement SHA-256`);
    const supplement = supplements.filter((item) => item.scope === 'missing-original-replacement' && item.replacesMissingSourceFileId === decision.sourceFileId &&
      item.sourcePath === path && item.revision === revision && item.sha256 === hash);
    const verified = replacements.get(path);
    if (supplement.length !== 1 || !verified || verified.sha256 !== hash) throw new Error(`Files#${decision.sourceFileId} replacement does not match one verified named supplement`);
    const reach: SqlDemoAssetReachability = { kind: 'sql-header' };
    const attestation = attestationId(file.id, file.url, path, hash, reach, headerReferences);
    offlineMedia.push({
      sourceFileType: 'image', sourceFileId: file.id, sourceUrl: file.url, archiveRelativePath: path,
      resolvedLocalPath: verified.resolvedLocalPath, reachability: reach,
      verification: { status: 'verified', loader: 'sql-demo-asset-loader', attestationId: attestation },
      detectedMimeType: verified.mime, detectedExtension: verified.extension,
      sourceBytesAvailable: false,
      substitution: { replacementSha256: hash, replacementPath: path, replacementRevision: revision },
    });
    provenanceAssets.push({ sourceFileType: 'image', sourceFileId: file.id, archiveRelativePath: path, reachability: reach,
      selectedPublicHeaderReferences: headerReferences.map((reference) => ({ ...reference })), sourceBytesAvailable: false,
      substitution: { replacementSha256: hash, replacementPath: path, replacementRevision: revision } });
  }
  for (const [fileId, usage] of reachability) {
    if (!entriesByFileId.has(fileId) && !approvedReplacementIds.has(fileId)) {
      const table = usage.articleIds.length ? 'Articles' : usage.videoIds.length ? 'Videos' : usage.bindingIds.length ? 'FileBindingOrganizationInfo' : 'Files';
      throw new Error(`${table} reaches Files#${fileId}, but the public asset manifest has no entry`);
    }
  }
  if (grantsByFileId.size > 0) {
    throw new Error(`body file grant for Files#${grantsByFileId.keys().next().value} does not match an unlinked public body image`);
  }

  return {
    offlineMedia,
    offlineDocuments,
    supplements,
    provenance: {
      baseline: { ...input.baseline },
      assets: provenanceAssets,
      supplements,
    },
  };
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} is not a lowercase SHA-256 digest`);
  }
}

function assertGitRevision(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${field} must be a full lowercase Git SHA`);
  }
}

function assertKnownFileStatus(file: NonNullable<SqlDemoAssetSource['Files']>[number]): void {
  if (!['active', 'disabled', 'unlinked'].includes(file.status)) {
    throw new Error(`Files#${file.id}.status is unknown`);
  }
  if (!['public', 'private'].includes(file.privacy)) {
    throw new Error(`Files#${file.id}.privacy is unknown`);
  }
  if (file.privacy !== 'public') throw new Error(`Files#${file.id}.privacy is private`);
  if (file.status === 'disabled') throw new Error(`Files#${file.id}.status is disabled`);
}

interface ParsedHtmlNode {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: ParsedHtmlNode[];
}

function imageSources(content: string): string[] {
  const sources: string[] = [];
  const visit = (node: ParsedHtmlNode): void => {
    if (node.tagName === 'img') {
      const source = node.attrs?.find((attribute) => attribute.name === 'src')?.value;
      if (source) sources.push(source);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parseFragment(content) as unknown as ParsedHtmlNode);
  return sources;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function assertManifestReachability(
  entry: SqlDemoAssetManifestEntry,
  usage: { headers: boolean; videoIds: number[]; bindingIds: number[]; articleIds: number[]; richTextReferences: { sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess' }[] },
  articleIds: number[],
  videoIds: number[],
  bindingIds: number[],
): void {
  const declared = entry.reachability;
  if (articleIds.length) {
    if (
      !declared || declared.kind !== 'article-body' || !Array.isArray(declared.articleSourceIds) ||
      !sameNumbers(declared.articleSourceIds, articleIds)
    ) {
      throw new Error(`Files#${entry.sourceFileId} article body reachability differs from active SQL body references`);
    }
    return;
  }
  if (!declared || typeof declared.kind !== 'string') {
    throw new Error(`Files#${entry.sourceFileId} manifest reachability is invalid`);
  }
  if (declared.kind === 'article-body') {
    throw new Error(`Files#${entry.sourceFileId} manifest article body reachability has no active body reference`);
  }
  if (declared.kind === 'video-thumbnail') {
    if (videoIds.length !== 1 || declared.videoSourceId !== videoIds[0]) {
      throw new Error(`Files#${entry.sourceFileId} video reachability does not match an active SQL thumbnail`);
    }
    return;
  }
  if (declared.kind === 'document-binding') {
    if (bindingIds.length !== 1 || declared.bindingSourceId !== bindingIds[0]) {
      throw new Error(`Files#${entry.sourceFileId} document binding does not match SQL identity`);
    }
    return;
  }
  if (declared.kind === 'public-rich-text') {
    const expected = usage.richTextReferences.map((item) => `${item.sourceTable}#${item.sourceId}.${item.sourceField}`).sort();
    const actual = Array.isArray(declared.references)
      ? declared.references.map((item) => `${item.sourceTable}#${item.sourceId}.${item.sourceField}`).sort()
      : [];
    if (expected.length && expected.length === actual.length && expected.every((value, index) => value === actual[index])) return;
    throw new Error(`Files#${entry.sourceFileId} public rich-text reachability differs from active SQL source references`);
  }
  if (declared.kind === 'sql-header' && usage.headers) return;
  throw new Error(`Files#${entry.sourceFileId} manifest reachability does not match active SQL relations`);
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assetReachability(
  usage: { headers: boolean; videoIds: number[]; bindingIds: number[]; articleIds: number[]; richTextReferences: { sourceTable: 'Programs' | 'Seminars'; sourceId: number; sourceField: 'content' | 'learningProcess' }[] },
  articleIds: number[],
  videoIds: number[],
  bindingIds: number[],
): SqlDemoAssetReachability {
  if (articleIds.length) return { kind: 'article-body', articleSourceIds: articleIds };
  if (usage.richTextReferences.length) return { kind: 'public-rich-text', references: usage.richTextReferences.map((item) => ({ ...item })) };
  if (videoIds.length) return { kind: 'video-thumbnail', videoSourceId: videoIds[0]! };
  if (bindingIds.length) return { kind: 'document-binding', bindingSourceId: bindingIds[0]! };
  if (usage.headers) return { kind: 'sql-header' };
  throw new Error('manifest asset has no supported SQL reachability');
}

function attestationId(
  sourceFileId: string,
  sourceUrl: string,
  archiveRelativePath: string,
  sourceSha256: string,
  reachability: SqlDemoAssetReachability,
  selectedPublicHeaderReferences: SqlDemoSelectedPublicHeaderReference[] = [],
  sourceReferenceAliases: string[] = [],
): string {
  return createHash('sha256').update(JSON.stringify({
    loader: 'sql-demo-asset-loader', sourceFileId, sourceUrl, archiveRelativePath, sourceSha256, reachability,
    ...(selectedPublicHeaderReferences.length ? { selectedPublicHeaderReferences } : {}),
    ...(sourceReferenceAliases.length ? { sourceReferenceAliases: [...new Set(sourceReferenceAliases)].sort() } : {}),
  })).digest('hex');
}

function pickAssetProvenance(
  proof: SqlDemoOfflineAssetProof | SqlDemoOfflineDocumentProof,
  selectedPublicHeaderReferences: SqlDemoSelectedPublicHeaderReference[],
): SqlDemoAssetProvenance {
  return {
    sourceFileType: proof.sourceFileType,
    sourceFileId: proof.sourceFileId,
    archiveRelativePath: proof.archiveRelativePath,
    ...('sourceSha256' in proof ? { sourceSha256: proof.sourceSha256 } : {}),
    reachability: proof.reachability,
    ...('sourceReferenceAliases' in proof && proof.sourceReferenceAliases?.length
      ? { sourceReferenceAliases: [...proof.sourceReferenceAliases] }
      : {}),
    ...('substitution' in proof && proof.substitution ? { substitution: { ...proof.substitution }, sourceBytesAvailable: false as const } : {}),
    ...(selectedPublicHeaderReferences.length
      ? { selectedPublicHeaderReferences: selectedPublicHeaderReferences.map((reference) => ({ ...reference })) }
      : {}),
  };
}

async function readVerifiedLocalFile(
  root: string,
  relativePath: string,
  expectedSha256: string,
  identity: string,
): Promise<{ bytes: Buffer; sourceSha256: string; resolvedLocalPath: string }> {
  if (
    typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') ||
    relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`local path is not a canonical relative path for ${identity}`);
  }
  assertSha256(expectedSha256, `${identity} SHA-256`);
  const realRoot = await realpath(root);
  const expectedPath = resolve(realRoot, ...relativePath.split('/'));
  const actualPath = await realpath(expectedPath);
  if (actualPath !== expectedPath) throw new Error(`local path resolves outside its exact path for ${identity}`);
  const bytes = await readFile(actualPath);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  if (sourceSha256 !== expectedSha256) throw new Error(`source SHA-256 differs from the pin for ${identity}`);
  return { bytes, sourceSha256, resolvedLocalPath: actualPath };
}

function safeVerificationError(identity: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : 'verification failed';
  const reason = /sha-?256|hash|digest/i.test(message)
    ? 'source SHA-256 verification failed'
    : /path|realpath|symbolic link|outside/i.test(message)
      ? 'local path verification failed'
      : /image|magic|raster/i.test(message)
        ? 'image byte magic verification failed'
        : /ENOENT|no such file/i.test(message)
          ? 'local source file is missing'
          : 'local source verification failed';
  return new Error(`${identity} ${reason}`);
}

async function verifySupplements(input: SqlDemoAssetLoaderInput): Promise<{
  supplements: SqlDemoAssetLoaderResult['supplements'];
  replacements: Map<string, { resolvedLocalPath: string; sha256: string; mime: SqlDemoOfflineAssetProof['detectedMimeType']; extension: SqlDemoOfflineAssetProof['detectedExtension'] }>;
}> {
  const manifest = input.supplementManifest;
  if (manifest.schemaVersion !== 1 || manifest.scope !== 'sql-demo-approved-supplements') {
    throw new Error('approved supplement manifest scope or version is invalid');
  }
  if (manifest.codeRevision !== input.expectedSupplements.codeRevision) {
    throw new Error('approved supplement code revision differs from the pinned revision');
  }
  assertGitRevision(manifest.codeRevision, 'supplement manifest code revision');
  assertSha256(manifest.sha256, 'supplement manifest SHA-256');
  assertSha256(input.expectedSupplements.manifestSha256, 'pinned supplement manifest SHA-256');
  const computed = computeSqlDemoSupplementManifestSha256(manifest);
  if (computed !== manifest.sha256 || computed !== input.expectedSupplements.manifestSha256) {
    throw new Error('supplement manifest SHA-256 differs from the pinned release');
  }

  const names = new Set<string>();
  const paths = new Set<string>();
  const assets = new Set(input.assetManifest.entries.map((entry) => entry.sourceFileId));
  const results: SqlDemoAssetLoaderResult['supplements'] = [];
  const replacements = new Map<string, { resolvedLocalPath: string; sha256: string; mime: SqlDemoOfflineAssetProof['detectedMimeType']; extension: SqlDemoOfflineAssetProof['detectedExtension'] }>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || names.has(entry.name)) {
      throw new Error('supplement manifest has a missing or duplicate named entry');
    }
    names.add(entry.name);
    if (paths.has(entry.sourcePath)) throw new Error(`supplement ${entry.name} has a duplicate local path`);
    paths.add(entry.sourcePath);
    assertGitRevision(entry.revision, `supplement ${entry.name} source revision`);
    assertSha256(entry.sha256, `supplement ${entry.name} SHA-256`);
    if (
      entry.scope === 'missing-original-replacement'
        ? !entry.replacesMissingSourceFileId || assets.has(entry.replacesMissingSourceFileId)
        : entry.replacesMissingSourceFileId !== undefined
    ) {
      throw new Error(`supplement ${entry.name} replacement identity does not name a missing source file`);
    }
    let verified: { bytes: Buffer; sourceSha256: string; resolvedLocalPath: string; mime?: string };
    try {
      if (entry.scope === 'public-video-thumbnail' || entry.scope === 'missing-original-replacement') {
        const raster = await readVerifiedOfflineImageSource({
          root: input.supplementRoot,
          sourceIdentity: `supplement ${entry.name}`,
          sourcePath: entry.sourcePath,
          sourceSha256: entry.sha256,
          sourceFilename: basename(entry.sourcePath),
        });
        verified = raster;
      } else if (entry.scope === 'public-static-page') {
        verified = await readVerifiedLocalFile(input.supplementRoot, entry.sourcePath, entry.sha256, `supplement ${entry.name}`);
      } else {
        throw new Error(`supplement ${entry.name} has an unsupported scope`);
      }
    } catch (error: unknown) {
      throw safeVerificationError(`supplement ${entry.name}`, error);
    }
    if (verified.sourceSha256 !== entry.sha256) {
      throw new Error(`supplement ${entry.name} SHA-256 differs from the manifest`);
    }
    results.push({
      sourcePath: entry.sourcePath,
      revision: entry.revision,
      sha256: verified.sourceSha256,
      scope: entry.scope,
      ...(entry.replacesMissingSourceFileId === undefined ? {} : { replacesMissingSourceFileId: entry.replacesMissingSourceFileId }),
    });
    if (entry.scope === 'missing-original-replacement') {
      const mime = verified.mime as SqlDemoOfflineAssetProof['detectedMimeType'] | undefined;
      if (!mime) throw new Error(`supplement ${entry.name} verifier did not return image magic`);
      replacements.set(entry.sourcePath, { resolvedLocalPath: verified.resolvedLocalPath, sha256: verified.sourceSha256, mime,
        extension: mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp' });
    }
  }
  return { supplements: results, replacements };
}
