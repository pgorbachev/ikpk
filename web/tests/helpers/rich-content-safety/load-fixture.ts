import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from './paths.js';

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as T;
}
