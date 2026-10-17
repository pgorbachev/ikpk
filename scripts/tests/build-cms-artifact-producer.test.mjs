import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const builderSource = join(repoRoot, 'scripts/build-cms-artifact.sh');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = {
  CMS_SOURCE_SHA: 'a'.repeat(40),
  CMS_SOURCE_REF: 'refs/heads/dev',
  CMS_RUN_ID: '38940517004',
  CMS_RUN_ATTEMPT: '2',
};

function tempDir(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function projectFixture(t) {
  const scratch = tempDir(t, 'ikpk-cms-artifact-producer-');
  const project = join(scratch, 'project');
  const sourceCms = join(repoRoot, 'cms');
  mkdirSync(project);
  cpSync(sourceCms, join(project, 'cms'), {
    recursive: true,
    filter(source) {
      const relativePath = source.slice(sourceCms.length).split(sep).filter(Boolean);
      return !relativePath.some((part) => ['node_modules', 'dist', '.cache', '.tmp'].includes(part));
    },
  });
  mkdirSync(join(project, 'scripts/lib'), { recursive: true });
  cpSync(builderSource, join(project, 'scripts/build-cms-artifact.sh'));
  cpSync(join(repoRoot, 'scripts/lib/release-migrations.sh'), join(project, 'scripts/lib/release-migrations.sh'));

  const dist = join(project, 'cms/dist');
  mkdirSync(join(dist, 'build'), { recursive: true });
  mkdirSync(join(dist, 'config'), { recursive: true });
  mkdirSync(join(dist, 'src'), { recursive: true });
  writeFileSync(join(dist, 'build/index.html'), '<!doctype html><title>fixture admin</title>\n');
  writeFileSync(join(dist, 'src/index.js'), 'module.exports = {};\n');
  writeFileSync(join(dist, 'config/database.js'), `module.exports.default = ({ env }) => ({ connection: { connection: { filename: env('DATABASE_FILENAME') } } });\n`);
  mkdirSync(join(dist, 'node_modules'), { recursive: true });
  writeFileSync(join(dist, 'node_modules/fixture.js'), 'must not ship\n');

  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  const npmLog = join(scratch, 'npm.log');
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(fakeNpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$IKPK_FAKE_NPM_LOG"\nif [ "$1" = "--version" ]; then printf "10.9.2\\n"; fi\n', 'utf8');
  chmodSync(fakeNpm, 0o700);
  return { scratch, project, dist, fakeBin, npmLog };
}

function runBuilder(f, args, env = {}) {
  return spawnSync('/bin/bash', [join(f.project, 'scripts/build-cms-artifact.sh'), ...args], {
    cwd: f.project,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, IKPK_FAKE_NPM_LOG: f.npmLog, ...env },
  });
}

function walkFiles(root, relative = '') {
  const current = join(root, relative);
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const info = lstatSync(join(root, child));
    assert.equal(info.isSymbolicLink(), false, `producer output contains symlink: ${child}`);
    return entry.isDirectory() ? walkFiles(root, child) : [child];
  }).sort();
}

test('explicit prebuilt mode assembles the already tested CMS output without rebuilding and binds its inventory', (t) => {
  const f = projectFixture(t), output = join(f.scratch, 'release-cms');
  const built = runBuilder(f, ['--prebuilt', output], identity);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
  assert.doesNotMatch(invocations, /^run build$/m, 'assembly-only mode reran the CMS compiler after E2E');
  assert.ok(existsSync(join(output, 'dist/build/index.html')), 'required Strapi admin build output was not packaged');
  assert.ok(existsSync(join(output, 'dist/src/index.js')), 'compiled CMS server output was not packaged');
  assert.ok(existsSync(join(output, 'database/migrations/plan.json')), 'versioned migration plan was not assembled');
  assert.ok(existsSync(join(output, 'database/.migrations-expected')), 'existing migration gate did not run on assembled output');
  assert.equal(existsSync(join(output, 'node_modules')), false, 'release artifact must exclude root node_modules');
  assert.equal(existsSync(join(output, 'dist/node_modules')), false, 'release artifact must exclude nested node_modules');

  const manifestPath = join(output, 'cms-artifact-manifest.json');
  assert.ok(existsSync(manifestPath), 'release artifact is missing its source/runtime/inventory manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.source, { sha: identity.CMS_SOURCE_SHA, ref: identity.CMS_SOURCE_REF,
    runId: Number(identity.CMS_RUN_ID), runAttempt: Number(identity.CMS_RUN_ATTEMPT) });
  assert.equal(manifest.packageLockSha256, sha256(readFileSync(join(output, 'package-lock.json'))));
  assert.equal(manifest.runtime.nodeMajor, Number(process.versions.node.split('.')[0]));
  assert.equal(manifest.runtime.nodeAbi, process.versions.modules);
  assert.match(manifest.runtime.npmVersion, /^\d+\.\d+\.\d+/);
  assert.doesNotMatch(JSON.stringify(manifest), /artifactDigest|zipDigest/i, 'outer GitHub ZIP digest must remain external to the archive');

  const files = walkFiles(output).filter((path) => path !== 'cms-artifact-manifest.json');
  assert.ok(files.every((path) => !path.split('/').includes('node_modules')), 'node_modules directory leaked into release inventory');
  assert.deepEqual(manifest.files.map(({ path }) => path).sort(), files, 'manifest inventory must cover every packaged file exactly');
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.sha256, sha256(readFileSync(join(output, entry.path))), `wrong file digest: ${entry.path}`);
  }
  assert.match(built.stdout, /миграций в релизе .* как и ожидалось/i, 'existing migration validator did not accept the assembled output');
});

test('prebuilt artifact excludes E2E-generated public uploads but retains the runtime directory and static public assets', (t) => {
  const f = projectFixture(t), output = join(f.scratch, 'release-cms');
  const uploads = join(f.project, 'cms/public/uploads');
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, 'e2e-generated-media.png'), Buffer.from('disposable E2E upload'));

  const built = runBuilder(f, ['--prebuilt', output], identity);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const packagedUploads = join(output, 'public/uploads');
  assert.ok(existsSync(packagedUploads), 'runtime uploads directory must remain available to CMS');
  assert.deepEqual(readdirSync(packagedUploads), ['.gitkeep'], 'runtime uploads must remain empty apart from its directory placeholder');
  assert.equal(existsSync(join(output, 'public/uploads/e2e-generated-media.png')), false);
  assert.equal(readFileSync(join(output, 'public/robots.txt'), 'utf8'),
    readFileSync(join(f.project, 'cms/public/robots.txt'), 'utf8'), 'ordinary static public assets must still be packaged');
  const manifest = JSON.parse(readFileSync(join(output, 'cms-artifact-manifest.json'), 'utf8'));
  assert.equal(manifest.files.some(({ path }) => path === 'public/uploads/e2e-generated-media.png'), false,
    'manifest must not claim excluded E2E media');
});

test('default builder refuses ./cms output before compiling or deleting source files', (t) => {
  const f = projectFixture(t), sourceFile = join(f.project, 'cms/package.json');
  const sourceBytes = readFileSync(sourceFile);
  const result = runBuilder(f, ['./cms']);
  assert.notEqual(result.status, 0, 'output overlapping the CMS source tree must be refused');
  assert.ok(existsSync(sourceFile), 'refusal must leave the CMS source tree intact');
  assert.deepEqual(readFileSync(sourceFile), sourceBytes, 'refusal changed a source file');
  const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
  assert.doesNotMatch(invocations, /^run build$/m, 'unsafe output must be refused before running the compiler');
});

test('default builder refuses an output reached through a symlinked parent before changing source', (t) => {
  const f = projectFixture(t), sourceFile = join(f.project, 'cms/package.json');
  const sourceBytes = readFileSync(sourceFile), alias = join(f.scratch, 'project-alias');
  symlinkSync(f.project, alias);
  const result = runBuilder(f, [join(alias, 'cms')]);
  assert.notEqual(result.status, 0, 'symlinked output overlapping the CMS source tree must be refused');
  assert.ok(existsSync(sourceFile), 'refusal must leave the symlink target source tree intact');
  assert.deepEqual(readFileSync(sourceFile), sourceBytes, 'refusal changed a source file through a symlinked parent');
  const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
  assert.doesNotMatch(invocations, /^run build$/m, 'unsafe symlink alias must be refused before compiling');
});

test('default builder refuses an existing output without removing its sentinel', (t) => {
  const f = projectFixture(t), output = join(f.scratch, 'existing-output'), sentinel = join(f.scratch, 'existing-output/sentinel.txt');
  mkdirSync(output);
  writeFileSync(sentinel, 'preserve this output\n');
  const result = runBuilder(f, [output]);
  assert.ok(existsSync(sentinel), 'builder deleted an existing output instead of refusing it');
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve this output\n', 'builder modified existing output bytes');
  assert.notEqual(result.status, 0, 'existing output must be refused');
});

test('prebuilt builder refuses an existing output without removing its sentinel', (t) => {
  const f = projectFixture(t), output = join(f.scratch, 'existing-prebuilt-output'), sentinel = join(f.scratch, 'existing-prebuilt-output/sentinel.txt');
  mkdirSync(output);
  writeFileSync(sentinel, 'preserve this prebuilt output\n');
  const result = runBuilder(f, ['--prebuilt', output], identity);
  assert.notEqual(result.status, 0, 'prebuilt output must be refused when it already exists');
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve this prebuilt output\n', 'prebuilt refusal changed existing output bytes');
  const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
  assert.doesNotMatch(invocations, /^run build$/m, 'prebuilt refusal must not invoke the compiler');
});

test('default builder refuses a parent-path alias before running build', (t) => {
  const f = projectFixture(t), sourceFile = join(f.project, 'cms/package.json');
  const sourceBytes = readFileSync(sourceFile);
  const result = runBuilder(f, ['cms/..']);
  assert.notEqual(result.status, 0, 'output aliasing the project root must be refused');
  assert.ok(existsSync(sourceFile), 'project-root refusal must preserve source files');
  assert.deepEqual(readFileSync(sourceFile), sourceBytes, 'project-root refusal changed source bytes');
  const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
  assert.doesNotMatch(invocations, /^run build$/m, 'project-root alias must be refused before build');
});

test('prebuilt mode refuses missing admin or compiled server output without invoking npm build', (t) => {
  for (const missingPath of ['dist/build/index.html', 'dist/src/index.js']) {
    const f = projectFixture(t), output = join(f.scratch, 'release-cms');
    rmSync(join(f.project, 'cms', missingPath));
    const result = runBuilder(f, ['--prebuilt', output], identity);
    assert.notEqual(result.status, 0, `prebuilt mode accepted missing ${missingPath}`);
    assert.ok((result.stderr + result.stdout).includes(missingPath), `refusal did not identify missing ${missingPath}`);
    const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
    assert.doesNotMatch(invocations, /^run build$/m, 'prebuilt refusal must not silently compile as fallback');
    assert.equal(existsSync(output), false, 'incomplete prebuilt output must be refused before artifact assembly');
  }
});

test('prebuilt mode requires complete exact-run identity before assembly or build', (t) => {
  for (const omitted of Object.keys(identity)) {
    const f = projectFixture(t), output = join(f.scratch, 'release-cms');
    const env = { ...identity };
    delete env[omitted];
    const result = runBuilder(f, ['--prebuilt', output], env);
    assert.notEqual(result.status, 0, `prebuilt mode accepted missing ${omitted}`);
    const invocations = existsSync(f.npmLog) ? readFileSync(f.npmLog, 'utf8') : '';
    assert.doesNotMatch(invocations, /^run build$/m, 'missing identity must not fall back to an unbound build');
    assert.equal(existsSync(output), false, 'unbound invocation must not create a release artifact');
  }
});

test('default CMS artifact mode continues to run the compiler', (t) => {
  const f = projectFixture(t), output = join(f.scratch, 'release-cms');
  const result = runBuilder(f, [output]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(readFileSync(f.npmLog, 'utf8'), /^run build$/m, 'default build behavior was accidentally changed to assembly-only');
});

test('release workflow packages and retains CMS artifact only after same-job unit/build and reused-build E2E succeed', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/release-tests.yml'), 'utf8');
  const supplementalStart = workflow.indexOf('\n  supplemental:');
  const supplementalEnd = workflow.indexOf('\n  visual:', supplementalStart);
  assert.ok(supplementalStart >= 0 && supplementalEnd > supplementalStart, 'supplemental release job is missing');
  const supplemental = workflow.slice(supplementalStart, supplementalEnd);
  const unitBuild = supplemental.indexOf('name: Run CMS unit tests and build');
  const cmsBuild = supplemental.indexOf('npm run build', unitBuild);
  const e2e = supplemental.indexOf('name: Run CMS to site against disposable local CMS and site');
  const reuseBuild = supplemental.indexOf("E2E_REUSE_ADMIN_BUILD: '1'", e2e);
  const packageStep = supplemental.indexOf('scripts/build-cms-artifact.sh --prebuilt', e2e);
  const upload = supplemental.indexOf('name: Upload CMS release artifact', packageStep);
  assert.ok(unitBuild >= 0 && cmsBuild > unitBuild && e2e > cmsBuild && reuseBuild > e2e && packageStep > reuseBuild && upload > packageStep,
    'CMS packaging must follow unit/build and E2E that reuses the same admin build');
  const uploadBlock = supplemental.slice(upload);
  assert.match(uploadBlock, /if:\s*success\(\)/, 'CMS artifact upload must be success-only');
  assert.match(uploadBlock, /name:\s*release-cms-artifact-\$\{\{\s*github\.run_attempt\s*\}\}/,
    'CMS artifact name must bind to the current attempt');
  assert.match(uploadBlock, /retention-days:\s*90/, 'CMS artifact must have the mandatory source-policy retention');
  assert.match(uploadBlock, /if-no-files-found:\s*error/, 'missing CMS artifact must fail the release job');
  assert.match(uploadBlock, /path:\s*\|[\s\S]*cms[^\n]*artifact|path:\s*[^\n]*cms[^\n]*artifact/i,
    'upload must point at the artifact assembled from this job’s cms/dist');
});
