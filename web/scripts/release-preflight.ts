#!/usr/bin/env node
// Node 24; read-only admission check for code packaging and installation.
import { readCiEvidence } from './lib/publication-ci.ts';

try {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--release-tag', '--commit'].includes(name) || options.has(name) || !value || value.startsWith('--')) throw new Error('invalid-arguments');
    options.set(name, value);
  }
  const commit = options.get('--commit') ?? '';
  const releaseTag = options.get('--release-tag') ?? '';
  const evidence = await readCiEvidence({ commit, releaseTag, token: process.env.GH_TOKEN });
  process.stdout.write(`${JSON.stringify({ status: 'admitted', commit, release: evidence.release,
    runs: [{ workflow: evidence.workflow, runId: evidence.runId }, ...evidence.workflows ?? []] })}\n`);
} catch {
  // HTTP bodies, credentials and report contents never enter the operator log.
  process.stderr.write('Release refused: require --release-tag vX.Y.Z --commit <full SHA>, a published stable GitHub Release and successful CI for that exact current main SHA.\n');
  process.exitCode = 1;
}
