import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlDemoNativeLocalIo } from './lib/sql-demo-native-local-io.js';
import { runSqlDemoNativePrototype, SqlDemoNativeRehearsalError } from './lib/sql-demo-native-rehearsal.js';
import { SQL_DEMO_PRIVATE_JSON_NAMES } from './lib/sql-demo-private-inputs.js';
import type { SqlDemoPrivateInputRootConfig } from './lib/sql-demo-private-inputs.js';
import type { SqlDemoAssetManifest } from './lib/sql-demo-assets.js';
import type { SqlPublicReaderOptions } from './lib/sql-public-reader.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRepo = '/private/tmp/ikpk-data-versions-sql-authority-2026-10-13';
const oldEvidence = '/private/tmp/ikpk-data-versions-owner-media-2026-10-13/evidence/2026-10-12';
const currentEvidence = '/private/tmp/ikpk-data-versions-owner-media-2026-10-13/evidence/2026-10-13';
const dumpPath = '/Users/pgorbachev/ikpk-data-versions-wt-dump-rehearsal/baseline/2026-10-10/ikpk-prod.sql';
const archivePath = '/Users/pgorbachev/ikpk-site-archive.zip';
const expectedDumpSha256 = 'b7b056d6a226b9caed224c737dad18dc366d47a0ec397e0ef0f1c66f61762be2';
const expectedArchiveSha256 = '2ec2142c9844b1e9afb2cc133a561d4cbf8b1ed0c7d75c4f5eaec924fbdd5e04';
const clusterPath = '/Users/pgorbachev/ikpk-rehearsal-20261012-1nzEFn/cluster';
const socketPath = '/Users/pgorbachev/ikpk-rehearsal-20261012-1nzEFn/socket';
const pgBin = '/opt/homebrew/opt/postgresql@18/bin';
const protoRoot = '/private/tmp/ikpk-demo193-prototype-A-20261013';
const privateInputsRoot = join(protoRoot, 'approved-assets');
const artifactsRoot = join(protoRoot, 'artifacts');
const cmsCandidateRoot = join(protoRoot, 'candidate');
const snapshotDirectory = join(protoRoot, 'live-snapshot');
const cmsData = join(protoRoot, 'sqlite');
const cmsUploads = join(protoRoot, 'uploads');
const cmsStaticFiles = join(protoRoot, 'static-files');
const targetUrl = 'http://127.0.0.1:19341';
const sourceConnection = { unixSocketPath: socketPath, port: 55438, database: 'ikpk_source_rehearsal', user: 'ikpk_restore' };
const pins: Record<(typeof SQL_DEMO_PRIVATE_JSON_NAMES)[number], { path: string; sha256: string }> = {
  'approved-supplements.json': { path: `${currentEvidence}/approved-supplements.json`, sha256: 'd10182a2d80a64cc38a5b079a083eba984c789b718dee9d7aeb5f6c935763834' },
  'reached-media-manifest.json': { path: `${oldEvidence}/reached-media-manifest.json`, sha256: '36b2e9dfc939c3945f94e323519cee05866d9ac1a0d2eb1a48202879741e0f46' },
  'article-body-reached-public-unlinked-media.json': { path: `${currentEvidence}/article-body-reached-public-unlinked-media.json`, sha256: '0e22a445249911489400831cb7199b582d90caf93f0cb474936670191191f02b' },
  'classification-candidates.json': { path: `${oldEvidence}/classification-candidates.json`, sha256: 'd53ee1390585e97667f36ce77d51d9c8b9e5d4368230843d8415c4b125052878' },
  'public-schema-inventory.json': { path: `${oldEvidence}/public-schema-inventory.json`, sha256: '074d6013c0d5a0f115a0e2d646fed55c56375053c1ee2430baabfd26422c8592' },
  'content-media-manifest.json': { path: `${oldEvidence}/content-media-manifest.json`, sha256: '1627c70d65ff4bda40b5e7b0cd3027c16d8cbb3f8aa4de960cded4e141ea4368' },
  'demo-owner-decisions.json': { path: `${currentEvidence}/demo-owner-decisions.json`, sha256: '21a7633a2849a33f374b11e460ff32e404aa8c4806a5ca91784f299a5589af98' },
  'video-source-reference-decisions.json': { path: `${oldEvidence}/video-source-reference-decisions.json`, sha256: '649ea844510e1d63b23a0193a0cc90dc306a693c322b808d0e49626cf1e2975b' },
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: artifactsRoot } }).trim();
}
async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await stat(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== uid) throw new Error('private directory ownership check failed');
  await chmod(path, 0o700);
}
async function digestFile(path: string): Promise<string> { return sha256(await readFile(path)); }

async function extractManifestMembers(manifest: SqlDemoAssetManifest, replacement: { sourceFileId: string; path: string; sha256: string; bytes: Uint8Array }): Promise<void> {
  const rows = manifest.entries.map((entry) => ({ path: entry.archiveRelativePath, sha256: entry.sha256, sourceFileId: entry.sourceFileId }));
  // The one approved Barral replacement is deliberately absent from this ZIP list:
  // its bytes come from the separately pinned Git supplement, not the missing original.
  if (rows.length !== 618 || manifest.entries.filter((entry) => entry.sourceFileType === 'image').length !== 562 ||
      manifest.entries.filter((entry) => entry.sourceFileType === 'document').length !== 56) {
    throw new Error('archive proof set was not 562 original raster plus 56 PDF; Barral replacement is separately pinned');
  }
  if (!replacement.sourceFileId || !/^[a-f\d]{64}$/i.test(replacement.sha256) || !replacement.path || isAbsolute(replacement.path) ||
      replacement.path.includes('\\') || replacement.path.split('/').some((part) => !part || part === '.' || part === '..') || sha256(replacement.bytes) !== replacement.sha256) {
    throw new Error('pinned missing-original replacement is not a safe private asset');
  }
  const python = String.raw`
import hashlib, json, os, pathlib, stat, sys, zipfile
archive, root = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
payload = json.load(sys.stdin)
rows = payload['rows']
root.mkdir(mode=0o700, parents=True, exist_ok=True)
seen=set(); claimed=set(); aggregate=hashlib.sha256(); total=0; missing=[]; ambiguous=0; validated=[]; written=0; reused=0
with zipfile.ZipFile(archive) as z:
  names=set(z.namelist())
  roots={pathlib.PurePosixPath(name).parts[0] for name in names if pathlib.PurePosixPath(name).parts}
  if len(roots) != 1: raise SystemExit('archive-top-level-root-not-unique')
  archive_root=next(iter(roots))
  if '/' in archive_root or '\\' in archive_root or archive_root in ('.', '..'): raise SystemExit('unsafe-archive-root')
  expected={payload['replacement']['path']}
  for row in rows:
    name=row['path']
    p=pathlib.PurePosixPath(name)
    if p.is_absolute() or '\\' in name or any(x in ('', '.', '..') for x in p.parts) or name in seen: raise SystemExit('unsafe-or-duplicate-path')
    seen.add(name)
    expected.add(name)
    member=name if name in names else f'{archive_root}/{name}'
    if member not in names:
      candidates=[candidate for candidate in names if candidate.startswith(archive_root+'/') and candidate.endswith('/'+name)]
      if len(candidates) != 1:
        if candidates: ambiguous += 1
        else: missing.append(False)
        continue
      member=candidates[0]
    if member not in names:
      missing.append(False)
      continue
    if member in claimed: raise SystemExit('archive-member-reused')
    claimed.add(member)
    member_path=pathlib.PurePosixPath(member)
    if member_path.is_absolute() or '\\' in member or any(x in ('', '.', '..') for x in member_path.parts): raise SystemExit('unsafe-archive-member-path')
    info=z.getinfo(member)
    if stat.S_ISLNK(info.external_attr >> 16): raise SystemExit('archive-symlink')
    data=z.read(info)
    digest=hashlib.sha256(data).hexdigest()
    if digest != row['sha256']: raise SystemExit('archive-byte-hash-mismatch')
    validated.append((row, p, data, digest))
  # Complete inventory and byte verification before creating any extracted files.
  if missing or ambiguous:
    print(json.dumps({'count':len(seen),'bytes':0,'identitySha256':hashlib.sha256().hexdigest(),'missingCount':len(missing),'missingApprovedReplacementCount':sum(missing),'missingOtherCount':len(missing)-sum(missing),'ambiguousMemberCount':ambiguous,'writtenCount':0,'reusedCount':0,'unexpectedExistingCount':0}))
    raise SystemExit(0)
  for row, p, data, digest in validated:
    target=(root / pathlib.Path(*p.parts)).resolve()
    if root not in target.parents: raise SystemExit('path-escape')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.exists():
      if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != row['sha256']: raise SystemExit('existing-file-hash-mismatch')
      reused += 1
    else:
      fd=os.open(target, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
      with os.fdopen(fd,'wb') as f: f.write(data)
      written += 1
    aggregate.update((name+'\0'+digest+'\n').encode()); total += len(data)
unexpected=0
for path in root.rglob('*'):
  if path.is_symlink(): raise SystemExit('existing-tree-symlink')
  if path.is_file() and path.relative_to(root).as_posix() not in expected: unexpected += 1
result={'count':len(seen),'bytes':total,'identitySha256':aggregate.hexdigest(),'missingCount':len(missing),'missingApprovedReplacementCount':sum(missing),'missingOtherCount':len(missing)-sum(missing),'ambiguousMemberCount':ambiguous,'writtenCount':written,'reusedCount':reused,'unexpectedExistingCount':unexpected}
print(json.dumps(result))
`;
  const output = execFileSync('python3', ['-c', python, archivePath, privateInputsRoot], {
    encoding: 'utf8', input: JSON.stringify({ rows, replacement }), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: artifactsRoot }, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const result = JSON.parse(output) as { count: number; bytes: number; identitySha256: string; missingCount: number; missingApprovedReplacementCount: number; missingOtherCount: number; ambiguousMemberCount: number; writtenCount: number; reusedCount: number; unexpectedExistingCount: number };
  if (result.count !== 618 || result.missingCount || result.ambiguousMemberCount || result.unexpectedExistingCount || !Number.isSafeInteger(result.bytes) || !/^[a-f0-9]{64}$/.test(result.identitySha256)) {
    throw new Error(`approved archive inventory mismatch (count=${result.count}, missing=${result.missingCount}, replacementMissing=${result.missingApprovedReplacementCount}, otherMissing=${result.missingOtherCount}, ambiguous=${result.ambiguousMemberCount}, unexpectedExisting=${result.unexpectedExistingCount})`);
  }
  const root = await realpath(privateInputsRoot);
  const parts = replacement.path.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('approved replacement parent is not a private directory');
  }
  const destination = join(parent, parts.at(-1)!);
  try {
    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink() || sha256(await readFile(destination)) !== replacement.sha256) throw new Error('existing approved replacement bytes mismatch');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(destination, replacement.bytes, { mode: 0o600, flag: 'wx' });
  }
  if (sha256(await readFile(destination)) !== replacement.sha256) throw new Error('materialized approved replacement hash mismatch');
}

async function main(): Promise<void> {
  for (const path of [protoRoot, artifactsRoot, cmsCandidateRoot]) await ensurePrivateDirectory(path);
  const repoReal = await realpath(repo);
  if (repoReal !== repo) throw new Error('prototype source path was not canonical');
  const sqlHash = await digestFile(dumpPath);
  const archiveHash = await digestFile(archivePath);
  if (sqlHash !== expectedDumpSha256 || archiveHash !== expectedArchiveSha256) throw new Error('pinned source artifact hash did not match');

  const privateJson = {} as Record<(typeof SQL_DEMO_PRIVATE_JSON_NAMES)[number], { bytes: Uint8Array; expectedSha256: string }>;
  for (const name of SQL_DEMO_PRIVATE_JSON_NAMES) {
    const pin = pins[name];
    const bytes = await readFile(pin.path);
    if (sha256(bytes) !== pin.sha256) throw new Error(`raw private JSON pin mismatch: ${name}`);
    privateJson[name] = { bytes, expectedSha256: pin.sha256 };
  }
  const decisionPath = join(privateRepo, 'evidence/2026-10-13/sql-active-records-owner-decision.json');
  const decisionBytes = await readFile(decisionPath);
  if (sha256(decisionBytes) !== '0149411316a006dbc12f0f662c0b6aebd9d9ed8140be66e04a32aca18cca061e') throw new Error('all-active owner decision pin mismatch');
  const decision = JSON.parse(decisionBytes.toString('utf8')) as {
    demoWriteOrImportAuthorization?: unknown;
    productionAcceptance?: unknown;
    identityAdditions?: { sourceTable: string; sourceId: number; identityAdditionApprovedForDemo193: boolean }[];
  };
  const additions = new Set((decision.identityAdditions ?? []).filter((row) => row.identityAdditionApprovedForDemo193).map((row) => `${row.sourceTable}#${row.sourceId}`));
  if (decision.demoWriteOrImportAuthorization !== true || decision.productionAcceptance !== false || additions.size !== 3 ||
      !['Seminars#361', 'Seminars#362', 'Teachers#88'].every((identity) => additions.has(identity))) throw new Error('all-active decision scope mismatch');
  const mediaDecision = JSON.parse(Buffer.from(privateJson['demo-owner-decisions.json'].bytes).toString('utf8')) as {
    ownerDecision?: { media?: { missingOriginalReplacements?: { sourceFileId: string; replacementPath: string; replacementRevision: string; replacementSha256: string; sourceBytesAvailable: boolean; demoApproved: boolean }[] } };
  };
  const replacements = mediaDecision.ownerDecision?.media?.missingOriginalReplacements ?? [];
  if (replacements.length !== 1 || replacements[0]!.sourceBytesAvailable !== false || replacements[0]!.demoApproved !== true) {
    throw new Error('pinned Barral missing-original replacement scope mismatch');
  }
  const replacement = replacements[0]!;

  const approved = JSON.parse(Buffer.from(privateJson['approved-supplements.json'].bytes).toString('utf8')) as { supplements: { path: string; revision: string; sha256: string; bytes: number }[] };
  if (!Array.isArray(approved.supplements) || approved.supplements.length !== 31) throw new Error('approved Git blob count mismatch');
  const supplementBlobs = approved.supplements.map((pin) => {
    if (!/^[a-f\d]{40}$/i.test(pin.revision) || isAbsolute(pin.path) || pin.path.split('/').includes('..')) throw new Error('approved Git blob pin is unsafe');
    const bytes = execFileSync('git', ['-C', repo, 'show', '--no-textconv', `${pin.revision}:${pin.path}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('approved Git blob bytes mismatch');
    return { path: pin.path, revision: pin.revision, sha256: pin.sha256, bytes };
  });
  const config: SqlDemoPrivateInputRootConfig = {
    baseline: { sqlSha256: expectedDumpSha256, archiveSha256: expectedArchiveSha256 },
    roots: { assetRoot: privateInputsRoot, supplementRoot: repo },
    acceptedLegacyIds: { Institutes: { 1: 'institut-klinicheskoy-prikladnoy-kineziologii', 2: 'institut-apledzhera', 3: 'institut-barralya' } },
    privateJson,
    supplementBlobs,
  };
  const cmsCommit = run('git', ['-C', repo, 'rev-parse', 'HEAD^{commit}']);
  const reader: SqlPublicReaderOptions = { dumpPath, expectedDumpHash: expectedDumpSha256, connection: sourceConnection };
  const io = createSqlDemoNativeLocalIo({
    source: { reader, clusterDataDirectory: clusterPath, postgresBinDirectory: pgBin, socketDirectory: socketPath, port: 55438, database: 'ikpk_source_rehearsal', user: 'ikpk_restore' },
    cms: { sourceDirectory: join(repo, 'cms'), expectedCommit: cmsCommit, candidateRoot: cmsCandidateRoot, nodeExecutable: process.execPath, cmsStartScript: 'start' },
    targets: { A: { baseUrl: targetUrl, namespace: 'ikpk_sql_demo_native_proto193', dataDirectory: cmsData, uploadDirectory: cmsUploads, staticFilesDirectory: cmsStaticFiles, resumeExistingMediaOnly: true } },
    privateArtifactsRoot: artifactsRoot,
    privateInputsRoot,
    resolveToken: async () => `local-native-prototype-${randomBytes(24).toString('hex')}`,
  });

  const result = await runSqlDemoNativePrototype({
    reader,
    privateInputConfig: config,
    target: { baseUrl: targetUrl, namespace: 'ikpk_sql_demo_native_proto193', dataDirectory: cmsData, uploadDirectory: cmsUploads, resumeExistingMediaOnly: true },
    snapshotDirectory,
    io,
    materializeApprovedAssets: async (manifest) => {
      const pin = supplementBlobs.filter((item) => item.path === replacement.replacementPath && item.revision === replacement.replacementRevision && item.sha256 === replacement.replacementSha256);
      if (pin.length !== 1) throw new Error('Barral replacement does not match one approved pinned Git blob');
      await extractManifestMembers(manifest, { sourceFileId: replacement.sourceFileId, path: replacement.replacementPath, sha256: replacement.replacementSha256, bytes: pin[0]!.bytes });
    },
  });
  const snapshot = JSON.parse(await readFile(join(snapshotDirectory, 'snapshot.json'), 'utf8')) as { snapshotId?: unknown; fingerprint?: unknown; content?: { media?: unknown[]; types?: Record<string, unknown[]> } };
  if (typeof snapshot.snapshotId !== 'string' || typeof snapshot.fingerprint !== 'string' || !snapshot.content?.media?.length) throw new Error('live CMS snapshot identity or media store was missing');
  const counts = Object.fromEntries(Object.entries(snapshot.content.types ?? {}).map(([name, rows]) => [name, rows.length]));
  const summary = {
    status: result.status,
    sourceSqlSha256: expectedDumpSha256,
    sourceArchiveSha256: expectedArchiveSha256,
    sourceCodeCommit: cmsCommit,
    ownerDecisionSha256: '0149411316a006dbc12f0f662c0b6aebd9d9ed8140be66e04a32aca18cca061e',
    target: 'A',
    cmsCounts: result.collectionCounts,
    snapshotId: snapshot.snapshotId,
    snapshotFingerprint: snapshot.fingerprint,
    snapshotCounts: counts,
    snapshotMediaCount: snapshot.content.media.length,
    cmsMediaCount: result.mediaCount,
    sourceFileIdentities: { raster: result.rasterCount, pdf: result.documentCount, total: result.rasterCount + result.documentCount },
    targetLocationCounts: result.targetLocationCounts,
    sourceUrlClassification: result.sourceUrlClassification,
    privateArtifactsDirectory: protoRoot,
  };
  const summaryPath = join(artifactsRoot, 'prototype-result.json');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: summary.status, snapshotId: summary.snapshotId, cmsCounts: summary.cmsCounts, sourceFileIdentities: summary.sourceFileIdentities })}\n`);
}

main().catch((error) => {
  const name = error instanceof Error ? error.name : 'unknown-error';
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const safeFrames = [...new Set(stack.split(/\r?\n/).map((line) => line.match(/((?:sql-demo-[a-z-]+|prototype-sql-demo)\.ts):(\d+):(\d+)/)?.slice(1).join(':')).filter(Boolean))];
  const diagnostic = error instanceof SqlDemoNativeRehearsalError ? error.diagnostic : undefined;
  process.stderr.write(`${JSON.stringify({ category: name, ...(error instanceof SqlDemoNativeRehearsalError ? { code: error.code, ...(error.identity && /^[A-Za-z][A-Za-z0-9]*#\d+$/.test(error.identity) ? { sourceIdentity: error.identity } : {}) } : {}), ...(diagnostic ? { causeCategory: diagnostic.causeCategory, causeFrames: diagnostic.frames, ...(diagnostic.sourceIdentity ? { sourceIdentity: diagnostic.sourceIdentity } : {}), ...(diagnostic.field && /^[A-Za-z][A-Za-z0-9_]*$/.test(diagnostic.field) ? { field: diagnostic.field } : {}), ...(diagnostic.networkCode && /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|FETCH_FAILED|UNKNOWN)$/.test(diagnostic.networkCode) ? { networkCode: diagnostic.networkCode } : {}), ...(diagnostic.signals ? { signals: diagnostic.signals } : {}) } : {}), frames: safeFrames, message: 'details withheld' })}\n`);
  process.exitCode = 1;
});
