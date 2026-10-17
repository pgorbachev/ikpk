#!/usr/bin/env node
/** Thin operator client: it never builds, reads CMS, or uploads an artifact. */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runReleaseCi, downloadCmsArtifactForEvidence } from './release-ci.mjs';
const SOURCE_REF = { demo: 'dev', prod: 'main' };
const PROOF_KEYS = ['repository', 'workflow', 'sourceRef', 'commit', 'runId', 'runAttempt', 'artifactDigest', 'artifactZipBase64'];
const fail = (message) => { throw new Error(message); };
const validId = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? '');
function protectedFile(path, secret = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('untrusted-client-config');
  if (/[\r\n\0]/.test(path)) fail('untrusted-client-config');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & (secret ? 0o077 : 0o022))) fail('untrusted-client-config');
  return realpathSync(path);
}
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) fail('untrusted-client-state');
  return realpathSync(path);
}
export function readClientConfig(home, destination) {
  if (!isAbsolute(home) || !['demo', 'prod'].includes(destination)) fail('invalid-destination');
  const directory = realpathSync(home);
  const stat = lstatSync(home); if (stat.isSymbolicLink() || (stat.mode & 0o022)) fail('untrusted-client-config');
  const c = JSON.parse(readFileSync(protectedFile(join(directory, `${destination}.json`)), 'utf8'));
  if (c.version !== 1 || c.destination !== destination || typeof c.sshTarget !== 'string' ||
      !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.:[\]-]*$/.test(c.sshTarget) || c.sshTarget.startsWith('root@') ||
      typeof c.serverEntry !== 'string' || !/^\/[A-Za-z0-9_./-]+\.mjs$/.test(c.serverEntry) || c.serverEntry.split('/').includes('..') ||
      typeof c.serverNode !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(c.serverNode) || c.serverNode.split('/').includes('..')) fail('untrusted-client-config');
  c.identityFile = protectedFile(c.identityFile, true); c.knownHostsFile = protectedFile(c.knownHostsFile);
  return c;
}
export function parseArguments(argv, id = randomUUID()) {
  const args = [...argv]; const destination = args.shift(); if (!['demo', 'prod'].includes(destination)) fail('usage: deploy.sh demo|prod [status ID|recover|rollback RELEASE --reason TEXT] [--request-id ID]');
  let action = 'publish', releaseId, reason, sha;
  if (args[0] === 'status') {
    args.shift(); const requestId = args.shift(); if (!validId(requestId) || args.length) fail('invalid-status-request');
    return { destination, action: 'status', id: requestId };
  }
  if (args[0] === 'recover') { args.shift(); action = 'recover'; }
  else if (args[0] === 'rollback') { args.shift(); action = 'rollback'; releaseId = args.shift(); }
  const seen = new Set();
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (seen.has(key) || !value || !['--request-id', ...(action === 'rollback' ? ['--reason'] : action === 'publish' ? ['--sha'] : [])].includes(key)) fail('invalid-arguments');
    seen.add(key); if (key === '--request-id') id = value; else if (key === '--sha') sha = value; else reason = value;
  }
  if (!validId(id) || (action === 'publish' && !/^[0-9a-f]{40}$/.test(sha ?? '')) || (action === 'rollback' && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId ?? '') || !reason?.trim() || reason.length > 500))) fail('invalid-arguments');
  return { id, destination, action, ...(action === 'publish' ? { sha } : {}), ...(action === 'rollback' ? { releaseId, reason } : {}) };
}
export function sshArguments(config, action, id) {
  if (!['submit', 'status'].includes(action) || (action === 'status' && !validId(id))) fail('invalid-remote-command');
  // OpenSSH concatenates remote arguments for a shell. Paths above allow only safe characters.
  return ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=20',
    '-o', `UserKnownHostsFile="${config.knownHostsFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`, '-i', config.identityFile, config.sshTarget,
    config.serverNode, config.serverEntry, action, ...(action === 'status' ? [id] : [])];
}
export function sshCall(config, action, request, submitFrame) {
  const result = spawnSync('/usr/bin/ssh', sshArguments(config, action, request.id), {
    input: action === 'submit' ? (submitFrame ?? Buffer.from(JSON.stringify(request))) : undefined,
    env: { PATH: '/usr/bin:/bin', HOME: homedir() }, encoding: 'utf8', timeout: 150000, maxBuffer: 64 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'] });
  let value; try { value = JSON.parse(result.stdout); } catch { fail(`connection-or-reply-lost; check status ${request.id}`); }
  if (!value || value.id !== request.id || value.destination !== config.destination ||
      !['accepted', 'running', 'success', 'refused', 'busy', 'interrupted', 'unknown', 'not-found'].includes(value.status)) fail(`untrusted-reply; check status ${request.id}`);
  return value;
}
export async function runClient(argv, { configHome = process.env.IKPK_DEPLOY_HOME ?? join(homedir(), '.config/ikpk-deploy'),
  stateHome = join(homedir(), '.local/state/ikpk-deploy'), call = sshCall,
  prepareCmsArtifact,
  admitSource = async ({ destination, sourceRef, sha }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ikpk-release-ci-'));
    try {
      const proof = await runReleaseCi({ sourceRef }, { commit: sha, directory: dir, request: { id: randomUUID(), destination } });
      return Object.fromEntries(['repository', 'workflow', 'sourceRef', 'commit', 'runId', 'runAttempt', 'artifactDigest', 'artifactZipBase64'].map((key) => [key, proof[key]]));
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  tagOps = {
    resolve(tag) {
      const refs = JSON.parse(execFileSync('gh', ['api', `repos/pgorbachev/ikpk/git/matching-refs/tags/${tag}`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (!Array.isArray(refs)) fail('source-tag-unverifiable');
      const exact = refs.filter((ref) => ref.ref === `refs/tags/${tag}`);
      if (exact.length > 1) fail('source-tag-unverifiable');
      if (!exact.length) return null;
      let object = exact[0].object;
      for (let depth = 0; depth < 5; depth++) {
        if (object?.type === 'commit' && /^[0-9a-f]{40}$/.test(object.sha ?? '')) return object.sha;
        if (object?.type !== 'tag' || !/^[0-9a-f]{40}$/.test(object.sha ?? '')) fail('source-tag-unverifiable');
        object = JSON.parse(execFileSync('gh', ['api', `repos/pgorbachev/ikpk/git/tags/${object.sha}`], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })).object;
      }
      fail('source-tag-unverifiable');
    },
    create(tag, sha) {
      const created = JSON.parse(execFileSync('gh', ['api', '--method', 'POST', 'repos/pgorbachev/ikpk/git/refs', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`],
        { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (created.ref !== `refs/tags/${tag}` || created.object?.type !== 'commit' || created.object?.sha !== sha) fail('source-tag-reservation-unconfirmed');
    },
  },
  resolveSourceRef = async ({ sourceRef }) => {
    try {
      const value = JSON.parse(execFileSync('gh', ['api', `repos/pgorbachev/ikpk/git/ref/heads/${sourceRef}`],
        { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (value.ref !== `refs/heads/${sourceRef}` || value.object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(value.object.sha ?? '')) fail('source-ref-unverifiable');
      return value.object.sha;
    } catch { fail('source-ref-unverifiable'); }
  },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), announce = (r) => process.stderr.write(`${JSON.stringify(r)}\n`),
  attempts = 2880 } = {}) {
  const request = parseArguments(argv); const config = readClientConfig(configHome, request.destination);
  if (request.action === 'status') return call(config, 'status', request);
  const prepareArtifact = prepareCmsArtifact ?? ((input) => downloadCmsArtifactForEvidence(input.sourceCiEvidence,
    { maxArchiveBytes: config.cmsArchiveMaxBytes }));
  const dir = join(stateHome, request.destination); const path = join(dir, `${request.id}.json`);
  let submitted, cmsArtifactMetadata;
  let archiveBytes;
  if (existsSync(dir)) privateDirectory(dir);
  if (existsSync(path)) {
    submitted = JSON.parse(readFileSync(protectedFile(path, true), 'utf8'));
    const matches = request.action === 'publish'
      ? submitted.id === request.id && submitted.destination === request.destination && submitted.action === 'publish' && submitted.sourceSha === request.sha
      : JSON.stringify(submitted) === JSON.stringify(request);
    if (!matches) fail('request-id-conflict');
    if (request.action === 'publish') {
      if (request.destination === 'prod' && submitted.sourceTag !== `prod-src-${request.sha}`) fail('request-id-conflict');
      let result = await call(config, 'status', submitted);
      if (result.status !== 'not-found') {
        for (let i = 0; ['accepted', 'running'].includes(result.status); i++) {
          if (i >= attempts) fail(`wait-limit; check status ${request.id}`);
          await sleep(5000); result = await call(config, 'status', request);
        }
        return result;
      }
      const sourceRef = SOURCE_REF[request.destination];
      const evidence = await admitSource({ destination: request.destination, sourceRef, sha: request.sha });
      validateSourceEvidence(evidence, sourceRef, request.sha);
      if (canonicalSourceEvidence(evidence) !== canonicalSourceEvidence(submitted.sourceCiEvidence)) fail('source-ci-evidence-changed');
      const prepared = await prepareArtifact({ destination: request.destination, sourceRef, sha: request.sha, sourceCiEvidence: evidence });
      validateCmsArtifactMetadata(prepared?.metadata, evidence, request.sha, prepared?.archiveBytes);
      if (JSON.stringify(prepared.metadata) !== JSON.stringify(submitted.cmsArtifact)) fail('cms-artifact-metadata-changed');
      archiveBytes = prepared.archiveBytes;
      cmsArtifactMetadata = prepared.metadata;
      if (request.destination === 'prod') {
        await requireCurrentSourceRef(resolveSourceRef, request.destination, sourceRef, request.sha);
        if (await tagOps.resolve(submitted.sourceTag) !== request.sha) fail('source-tag-conflict');
      }
      announce({ id: request.id, destination: request.destination, status: 'request-retry', receipt: path });
      if (request.destination === 'prod') await requireCurrentSourceRef(resolveSourceRef, request.destination, sourceRef, request.sha);
      result = await call(config, 'submit', submitted, makeSubmitFrame(submitted, archiveBytes));
      for (let i = 0; ['accepted', 'running'].includes(result.status); i++) {
        if (i >= attempts) fail(`wait-limit; check status ${request.id}`);
        await sleep(5000); result = await call(config, 'status', request);
      }
      return result;
    }
  } else {
  let sourceCiEvidence, sourceTag;
  if (request.action === 'publish') {
    const sourceRef = SOURCE_REF[request.destination];
    sourceCiEvidence = await admitSource({ destination: request.destination, sourceRef, sha: request.sha });
    validateSourceEvidence(sourceCiEvidence, sourceRef, request.sha);
    const prepared = await prepareArtifact({ destination: request.destination, sourceRef, sha: request.sha, sourceCiEvidence });
    validateCmsArtifactMetadata(prepared?.metadata, sourceCiEvidence, request.sha, prepared?.archiveBytes);
    archiveBytes = prepared.archiveBytes; cmsArtifactMetadata = prepared.metadata;
    if (request.destination === 'prod') {
      await requireCurrentSourceRef(resolveSourceRef, request.destination, sourceRef, request.sha);
      sourceTag = `prod-src-${request.sha}`;
      let existing;
      try { existing = await tagOps.resolve(sourceTag); } catch { fail('source-tag-unverifiable'); }
      if (existing !== null && existing !== request.sha) fail('source-tag-conflict');
      if (existing === null) {
        try { await tagOps.create(sourceTag, request.sha); }
        catch {
          try { existing = await tagOps.resolve(sourceTag); } catch { fail('source-tag-unverifiable'); }
          if (existing !== request.sha) fail('source-tag-reservation-failed');
        }
      }
    }
  }
  const { sha, ...baseRequest } = request;
  submitted = { ...baseRequest, ...(request.action === 'publish' ? { sourceSha: sha, sourceCiEvidence, cmsArtifact: cmsArtifactMetadata, ...(sourceTag ? { sourceTag } : {}) } : {}) };
    privateDirectory(dir);
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(submitted)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(dir, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  // ID is durable and displayed BEFORE sending the request.
  announce({ id: request.id, destination: request.destination, status: 'request-saved', receipt: path });
  if (request.destination === 'prod' && request.action === 'publish') {
    await requireCurrentSourceRef(resolveSourceRef, request.destination, SOURCE_REF.prod, request.sha);
  }
  let result = await call(config, 'submit', submitted, makeSubmitFrame(submitted, request.action === 'publish' ? archiveBytes : Buffer.alloc(0)));
  for (let i = 0; ['accepted', 'running'].includes(result.status); i++) {
    if (i >= attempts) fail(`wait-limit; check status ${request.id}`);
    await sleep(5000); result = await call(config, 'status', request);
  }
  return result;
}
function validateSourceEvidence(evidence, sourceRef, sha) {
  if (!evidence || evidence.repository !== 'pgorbachev/ikpk' || evidence.workflow !== '.github/workflows/release-tests.yml' ||
      Object.keys(evidence).sort().join(',') !== [...PROOF_KEYS].sort().join(',') || evidence.sourceRef !== sourceRef ||
      evidence.commit !== sha || !Number.isSafeInteger(evidence.runId) || evidence.runId < 1 ||
      !Number.isSafeInteger(evidence.runAttempt) || evidence.runAttempt < 1 ||
      typeof evidence.artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.artifactDigest) ||
      typeof evidence.artifactZipBase64 !== 'string' || evidence.artifactZipBase64.length > 4 * Math.ceil((4 * 1024 * 1024) / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(evidence.artifactZipBase64)) fail('source-ci-evidence-mismatch');
  const archive = Buffer.from(evidence.artifactZipBase64, 'base64');
  if (archive.length > 4 * 1024 * 1024 || archive.toString('base64') !== evidence.artifactZipBase64 ||
      `sha256:${createHash('sha256').update(archive).digest('hex')}` !== evidence.artifactDigest) fail('source-ci-evidence-mismatch');
}
function canonicalSourceEvidence(evidence) { return JSON.stringify(Object.fromEntries(PROOF_KEYS.map((key) => [key, evidence[key]]))); }
function validateCmsArtifactMetadata(metadata, evidence, sha, archiveBytes) {
  if (!metadata || !Buffer.isBuffer(archiveBytes) || metadata.expired !== false ||
      Object.keys(metadata).sort().join(',') !== 'digest,expired,id,name,runAttempt,size_in_bytes,workflow_run' ||
      !metadata.workflow_run || Object.keys(metadata.workflow_run).sort().join(',') !== 'head_sha,id' ||
      metadata.name !== `release-cms-artifact-${evidence.runAttempt}` || !Number.isSafeInteger(metadata.id) || metadata.id < 1 ||
      metadata.runAttempt !== evidence.runAttempt || metadata.size_in_bytes !== archiveBytes.length ||
      metadata.workflow_run?.id !== evidence.runId || metadata.workflow_run?.head_sha !== sha ||
      !/^sha256:[0-9a-f]{64}$/.test(metadata.digest ?? '') ||
      `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}` !== metadata.digest) fail('cms-artifact-metadata-mismatch');
}
function makeSubmitFrame(request, archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes)) fail('cms-artifact-missing');
  const control = Buffer.from(JSON.stringify(request));
  if (control.length > 8 * 1024 * 1024) fail('request-too-large');
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(control.length), 0); header.writeBigUInt64BE(BigInt(archiveBytes.length), 8);
  return Buffer.concat([header, control, archiveBytes]);
}
async function requireCurrentSourceRef(resolveSourceRef, destination, sourceRef, sha) {
  let current;
  try { current = await resolveSourceRef({ destination, sourceRef }); } catch { fail('source-ref-unverifiable'); }
  if (current !== sha) fail('source-ref-changed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runClient(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'success') process.exitCode = 1;
  } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'refused', reason: error.message })}\n`); process.exitCode = 1; }
}
