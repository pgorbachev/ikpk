import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const target = join(webRoot, 'node_modules');
const link = join(repoRoot, 'node_modules');

try {
  if (existsSync(target) && (!existsSync(link) || !lstatSync(link).isSymbolicLink())) {
    if (!existsSync(link)) symlinkSync(target, link);
  }
} catch (err) {
  console.error('ensure-tsx-root:', err);
}
