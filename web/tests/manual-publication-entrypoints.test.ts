import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');
const gateModule = join(import.meta.dirname, 'helpers/publication-entrypoints.ts');
const approved = 'scripts/publication-launcher.mjs';
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function inventory(root: string): Promise<string[]> {
  const gate = await import(/* @vite-ignore */ gateModule) as { inventoryPublicationEntrypoints(root: string): string[] };
  expect(typeof gate.inventoryPublicationEntrypoints).toBe('function');
  return gate.inventoryPublicationEntrypoints(root);
}
function put(root: string, name: string, source: string, executable = false) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  if (executable) chmodSync(path, 0o755);
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-entry-inventory-'));
  temporary.push(root);
  // Real executable trust chain, including private native entry guards. The backup
  // restore utility is deliberately tested separately: it currently bypasses this chain.
  for (const name of [approved, 'scripts/deploy-web.sh', 'scripts/publication-transport.mjs',
    'scripts/lib/publication-remote.py', 'web/scripts/publication-worker.ts',
    'web/scripts/publication-operator.ts', 'web/scripts/publication-context.ts',
    'web/scripts/publication-audit.ts']) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(join(repository, name), join(root, name));
  }
  cpSync(join(repository, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
  put(root, 'web/package.json', JSON.stringify({ scripts: { test: 'vitest run', build: 'astro build' } }));
  return root;
}

// These are configuration/known-literal capability tests, not an assertion that a
// scanner can prove arbitrary program semantics. The real native launcher/transport
// authorization suites separately test the runtime trust boundary.
describe('one declared local publication entrypoint plus hosted inventory', () => {
  beforeEach(() => {
    // Outside rejects.toThrow: a missing gate must never make a negative case green.
    expect(existsSync(gateModule), 'task 6.1 requires the executable local/hosted publication inventory gate').toBe(true);
  });
  it('recognizes the real protected launcher chain as one path in a positive fixture', async () => {
    expect(await inventory(fixture())).toEqual([approved]);
  });
  it('the actual repository has exactly that one approved publication path', async () => {
    expect(await inventory(repository)).toEqual([approved]);
  });
  it('refuses zero when the launcher is missing', async () => {
    const root = fixture();
    rmSync(join(root, approved));
    await expect(inventory(root)).rejects.toThrow();
  });
  it('does not count an inert file at the declared path as an executable publisher', async () => {
    const root = fixture();
    put(root, approved, '#!/usr/bin/env node\nconsole.log("checks only");\n');
    await expect(inventory(root)).rejects.toThrow();
  });
  it('refuses a copied second launcher even under an unrelated name', async () => {
    const root = fixture();
    put(root, 'tools/maintenance.mjs', readFileSync(join(repository, approved), 'utf8'), true);
    await expect(inventory(root)).rejects.toThrow();
  });
  it('refuses a renamed executable that transfers the web artifact directly', async () => {
    const root = fixture();
    put(root, 'tools/maintenance.sh', '#!/bin/sh\nrsync -az web/dist/ operator@host:/var/www/ikpk/releases/new/\n', true);
    await expect(inventory(root)).rejects.toThrow();
  });
  it('refuses a local current switch even without SSH or a deploy-like filename', async () => {
    const root = fixture();
    put(root, 'tools/maintenance.sh', '#!/bin/sh\nWEB_ROOT=/var/www/ikpk\nln -sfn "$WEB_ROOT/releases/old" "$WEB_ROOT/current.new"\nmv -T "$WEB_ROOT/current.new" "$WEB_ROOT/current"\n', true);
    await expect(inventory(root)).rejects.toThrow();
  });
  it('recognizes the actual legacy backup restore as a second publication path', async () => {
    const root = fixture();
    copyFileSync(join(repository, 'web/tests/fixtures/manual-publication/legacy-restore-server-state.sh'), join(root, 'scripts/restore-server-state.sh'));
    await expect(inventory(root)).rejects.toThrow();
  });
  it('follows an npm lifecycle wrapper into a private worker bypass', async () => {
    const root = fixture();
    put(root, 'web/package.json', JSON.stringify({ scripts: { test: 'vitest run', pretest: 'bash ../tools/maintenance.sh' } }));
    put(root, 'tools/maintenance.sh', '#!/bin/sh\nnode ../web/scripts/publication-worker.ts "$@"\n');
    await expect(inventory(root)).rejects.toThrow();
  });
  it('refuses a direct npm private operator entrypoint', async () => {
    const root = fixture();
    put(root, 'web/package.json', JSON.stringify({ scripts: { maintenance: 'node scripts/publication-operator.ts rollback' } }));
    await expect(inventory(root)).rejects.toThrow();
  });
  it('counts a hosted publisher against the same sole-path requirement', async () => {
    const root = fixture();
    put(root, '.github/workflows/maintenance.yml', 'name: Maintenance\non: workflow_dispatch\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: rsync -az web/dist/ operator@host:/var/www/ikpk/releases/new/\n');
    await expect(inventory(root)).rejects.toThrow();
  });
  it('does not count comments or ordinary build/check commands as new publishers', async () => {
    const root = fixture();
    put(root, 'tools/check.sh', '#!/bin/sh\n# rsync web/dist/ operator@host:/releases\n# mv current.new current\nnode --version\n', true);
    expect(await inventory(root)).toEqual([approved]);
  });
  it('inspects executable files without a language extension', async () => {
    const root = fixture();
    put(root, 'tools/maintenance', '#!/bin/sh\nrsync -az output/ operator@host:/srv/site/releases/new/\n', true);
    await expect(inventory(root)).rejects.toThrow('web-transfer');
  });
  it('allows local launcher wrappers without counting a second implementation', async () => {
    const root = fixture();
    put(root, 'tools/maintenance.sh', '#!/bin/sh\nnode scripts/publication-launcher.mjs "$@"\n', true);
    expect(await inventory(root)).toEqual([approved]);
  });
  it('refuses a hosted npm lifecycle invoking the approved local launcher', async () => {
    const root = fixture();
    put(root, 'web/package.json', JSON.stringify({ scripts: { pretest: 'node ../scripts/publication-launcher.mjs publish' } }));
    put(root, '.github/workflows/maintenance.yml', 'name: Maintenance\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n        working-directory: web\n');
    await expect(inventory(root)).rejects.toThrow('hosted');
  });
});
