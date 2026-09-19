import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { walkHtml } from '../helpers/dist-pages';

export const webRoot = resolve(import.meta.dirname, '../..');
export const repoRoot = resolve(webRoot, '..');
export function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`missing ${name}`);
  return value;
}
export function tree(): string {
  const path = required('PUBLICATION_TREE_DIR');
  expect(isAbsolute(path), 'absolute artifact path required').toBe(true);
  expect(statSync(path).isDirectory()).toBe(true);
  return path;
}
export function pages() {
  const root = tree();
  const files = [...walkHtml(root)];
  expect(files.length, 'empty artifact').toBeGreaterThan(0);
  return files.map((file) => ({ file, route: `/${relative(root, file).replace(/index\.html$/, '')}`, html: readFileSync(file, 'utf8') }));
}
export function resolves(pathname: string): boolean {
  const path = resolve(tree(), `.${decodeURIComponent(pathname)}`);
  if (relative(tree(), path).startsWith('..')) return false;
  return (existsSync(path) && statSync(path).isFile()) || existsSync(join(path, 'index.html')) || existsSync(`${path}.html`);
}
export function redirectRules() {
  const conf = readFileSync(join(repoRoot, 'deploy/nginx-redirects.conf'), 'utf8');
  expect(conf.split('\n').filter((line) => /^\s*location\b/.test(line) && line.includes('?'))).toEqual([]);
  const redirects = [...conf.matchAll(/location = (\S+) \{ return 301 (\S+); \}/g)].map((match) => ({ from: match[1], to: match[2] }));
  expect(redirects.length).toBeGreaterThan(0);
  return redirects;
}
type DeployCheck = 'form_links_match_mode' | 'chat_widget_matches_mode' | 'payment_endpoint_matches' | 'payment_endpoint_reachable' | 'payment_cors_allows';
export function deployCheck(name: DeployCheck, ...args: string[]) {
  const script = 'set -euo pipefail; source "$1"; shift; fn="$1"; shift; "$fn" "$@"';
  const result = spawnSync('/bin/bash', ['-c', script, 'publication-check', join(repoRoot, 'scripts/lib/deploy-checks.sh'), name, ...args], {
    env: { PATH: required('PATH'), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}
export function activePayment() {
  const role = required('PAYMENT_ROLE');
  expect(['stand', 'prod']).toContain(role);
  return { role, endpoint: required('PUBLICATION_PAYMENT_ENDPOINT'),
    mode: required('PUBLICATION_PAYMENT_MODE'), shop: required('PUBLICATION_PAYMENT_SHOP_ID'), origin: required('PUBLICATION_PAYMENT_SITE_ORIGIN') };
}
