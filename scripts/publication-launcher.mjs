#!/usr/bin/env node
/**
 * RED-only executable contract placeholder for manual-publication-only.
 * This deliberately does not authorize, build, release credentials or publish.
 * Replace it with the trusted launcher implementation after the independent RED run.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function digestTree(_rootDir, _filePaths) {
  throw new Error('not-implemented: deterministic publication tree digest');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify({ status: 'not-implemented', executedChecks: 0 })}\n`);
  process.exitCode = 78;
}
