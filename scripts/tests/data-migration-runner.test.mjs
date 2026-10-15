import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = join(repoRoot, 'cms/database/migrations/plan.json');
const artifactBuilder = join(repoRoot, 'scripts/build-cms-artifact.sh');
const migrationGate = join(repoRoot, 'scripts/lib/release-migrations.sh');
const bootstrapPath = join(repoRoot, 'scripts/bootstrap-vps.sh');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tempDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runReleaseGate(t, { plannedBytes, actualBytes }) {
  const release = tempDirectory(t, 'ikpk-release-hash-gate-');
  const migrations = join(release, 'database/migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, 'step.js'), actualBytes);
  writeFileSync(join(release, 'database/.migrations-expected'), '1\n');
  writeFileSync(join(migrations, 'plan.json'), JSON.stringify({
    version: 1,
    steps: [{
      id: 'fixture-step-v1',
      phase: 'before-sync',
      path: 'step.js',
      sha256: sha256(plannedBytes),
      source: { strapiVersion: '5.51.2', schema: { engine: 'sqlite', requiredColumns: { fixture: ['id', 'value'] } } },
      preconditions: { fixture: true },
      postconditions: { fixture: true },
      readback: { fixture: true },
    }],
  }, null, 2));

  const script = `set -euo pipefail\n${readFileSync(migrationGate, 'utf8')}\ncheck_release_migrations "${release}"\n`;
  const result = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

test('release plan gives every immutable step a phase, payload hash, provenance, and readback', () => {
  assert.ok(existsSync(manifestPath), 'versioned cms/database/migrations/plan.json is required');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.steps) && manifest.steps.length > 0, 'an empty plan is not a verified migration');

  const ids = new Set();
  for (const step of manifest.steps) {
    assert.match(step.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/, 'step ID must be stable and explicit');
    assert.ok(!ids.has(step.id), `duplicate step ID: ${step.id}`);
    ids.add(step.id);
    assert.ok(['before-sync', 'after-sync'].includes(step.phase), `unsupported phase for ${step.id}`);
    assert.ok(typeof step.path === 'string' && step.path.length > 0, `missing artifact path for ${step.id}`);
    assert.match(step.sha256, /^[a-f0-9]{64}$/, `missing exact payload hash for ${step.id}`);
    assert.ok(step.source && typeof step.source.strapiVersion === 'string', `missing source Strapi version for ${step.id}`);
    assert.ok(step.source.schema && step.source.schema.engine === 'sqlite', `missing supported source schema constraints for ${step.id}`);
    assert.ok(step.source.schema.requiredColumns && Object.keys(step.source.schema.requiredColumns).length > 0, `source schema constraints are empty for ${step.id}`);
    assert.ok(step.preconditions && typeof step.preconditions === 'object', `missing preconditions for ${step.id}`);
    assert.ok(step.postconditions && typeof step.postconditions === 'object', `missing postconditions for ${step.id}`);
    assert.ok(step.readback && typeof step.readback === 'object', `missing readback contract for ${step.id}`);

    const relativePath = step.path;
    assert.ok(!relativePath.startsWith('/') && !relativePath.split(/[\\/]/).includes('..'), `step path escapes artifact: ${relativePath}`);
    const payloadPath = join(repoRoot, 'cms/database/migrations', relativePath);
    assert.ok(existsSync(payloadPath), `manifest payload is missing: ${relativePath}`);
    assert.equal(sha256(readFileSync(payloadPath)), step.sha256, `payload bytes differ from frozen hash: ${relativePath}`);
  }
});

test('CMS release artifact contains the manifest and every packaged data-step helper', (t) => {
  const scratch = tempDirectory(t, 'ikpk-migration-artifact-');
  const fakeBin = join(scratch, 'bin');
  const artifact = join(scratch, 'artifact');
  mkdirSync(fakeBin);

  // Satisfy only the CMS build boundary; the real artifact script copies and validates
  // repository outputs. This avoids installing or building Strapi just to test packaging.
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(fakeNpm, '#!/bin/sh\nmkdir -p dist/config\nprintf "%s\\n" "module.exports = { default: ({ env }) => ({ connection: { connection: { filename: env(\\\"DATABASE_FILENAME\\\") } } }) };" > dist/config/database.js\n', 'utf8');
  chmodSync(fakeNpm, 0o700);

  const built = spawnSync('/bin/bash', [artifactBuilder, artifact], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  assert.ok(existsSync(join(artifact, 'database/migrations/plan.json')), 'the artifact omitted its migration plan');
  assert.ok(existsSync(join(artifact, 'scripts/institute-method-author-classification.mjs')), 'classification helper is not deployable');
  assert.ok(existsSync(join(artifact, 'scripts/normalize-null-documents-state.mjs')), 'normalization helper is not deployable');
});

test('release gate rejects a substituted migration even when the declared file count still matches', (t) => {
  const plannedBytes = Buffer.from("module.exports = { async up() {} };\n");
  const actualBytes = Buffer.from("module.exports = { async up() { throw new Error('substituted'); } };\n");
  const result = runReleaseGate(t, { plannedBytes, actualBytes });
  assert.notEqual(result.status, 0, 'same-count migration substitution passed the release gate');
  assert.match(result.stderr + result.stdout, /(sha|hash|хеш)/i, 'refusal did not identify the payload-hash mismatch');
});

test('legacy CMS failure branch refuses code-only rollback when no matching database snapshot exists', (t) => {
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  const healthyStart = bootstrap.indexOf('if ((healthy)); then');
  const start = bootstrap.indexOf('if [[ -n "$previous_target" ]]; then', healthyStart);
  assert.ok(start >= 0, 'CMS failure rollback branch is missing');
  const end = bootstrap.indexOf('echo "[bootstrap] служба системы управления не ответила', start);
  assert.ok(end > start, 'cannot isolate CMS failure rollback branch');
  const branch = bootstrap.slice(start, end);
  const scratch = tempDirectory(t, 'ikpk-bootstrap-rollback-');
  const oldRelease = join(scratch, 'releases/old');
  const newRelease = join(scratch, 'releases/new');
  const currentLink = join(scratch, 'current');
  const bin = join(scratch, 'mock-bin');
  const events = join(scratch, 'events.log');
  mkdirSync(join(oldRelease, 'database'), { recursive: true });
  mkdirSync(join(newRelease, 'database'), { recursive: true });
  mkdirSync(bin);
  symlinkSync(newRelease, currentLink);

  for (const command of ['ln', 'mv', 'systemctl']) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$*" >> "$IKPK_TEST_EVENTS"\n`, 'utf8');
    chmodSync(executable, 0o700);
  }

  // Execute the actual extracted failure branch. Mocking switch/restart commands records
  // attempted external effects while keeping all paths under this test's temporary root.
  const harness = `set -euo pipefail\n${branch}\n`;
  const result = spawnSync('/bin/bash', ['-c', harness], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IKPK_TEST_EVENTS: events,
      previous_target: oldRelease,
      new_release: newRelease,
      current_link: currentLink,
      unit_name: 'ikpk-cms-fixture.service',
      ENVIRONMENT: 'production-fixture',
      SERVICE_ADDR: '127.0.0.1:0',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const attempted = existsSync(events) ? readFileSync(events, 'utf8') : '';
  assert.doesNotMatch(attempted, /^ln -sfn .*\/old /m, 'old code was switched despite missing pair restoration proof');
  assert.doesNotMatch(attempted, /systemctl restart/, 'old CMS was started against the new database');
  assert.equal(readlinkSync(currentLink), newRelease, 'active code pointer changed on an unpaired rollback attempt');
});
