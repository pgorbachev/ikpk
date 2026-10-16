#!/usr/bin/env node
/** Installed root helper; the publisher receives only a fixed systemd start permission. */
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureId, assertConfig, assertProtected, captureBundle, recoverWriters } from './lib/server-capture-bundle.mjs';

const CONFIG_PATH = '/etc/ikpk/demo-capture.json';
function protectedTree(path) {
  assertProtected(path);
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) protectedTree(join(path, name));
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || !['capture', 'resume'].includes(args[0])) throw new Error('usage: server-capture.mjs capture|resume PUBLICATION_ID');
  const [action, id] = args; assertCaptureId(id);
  if (process.getuid?.() !== 0) throw new Error('server capture requires the installed root helper');
  const script = fileURLToPath(import.meta.url);
  assertProtected(process.execPath);
  assertProtected(script);
  for (const file of ['server-capture-bundle.mjs', 'server-capture-sqlite.mjs']) assertProtected(join(dirname(script), 'lib', file));
  assertProtected(CONFIG_PATH);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assertConfig(config, { checkPaths: action === 'capture' });
  assertProtected(config.leaseRoot);
  if (action === 'resume') { recoverWriters(config, id); return; }
  assertProtected(config.bundleRoot);
  protectedTree(config.schemaRoot);
  if (!Number.isSafeInteger(config.publisherGid) || config.publisherGid <= 0) throw new Error('dedicated publisher group required');
  const result = await captureBundle(config, id);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`server-capture: ${error.message}`); process.exitCode = 1; });
}
