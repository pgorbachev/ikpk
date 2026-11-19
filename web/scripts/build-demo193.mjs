import { spawnSync } from 'node:child_process';
import { resolveDemo193Environment } from './demo193-profile.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--staging194-registration-links')) {
  throw new Error('unknown demo193 build argument');
}
const env = resolveDemo193Environment(process.env, args.length === 1);
const commands = [
  ['astro', ['build', '--outDir', 'dist-demo193']],
  ['pagefind', ['--site', 'dist-demo193']],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
