// Builtin-only protected configuration validation; safe before installed dependencies.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface DestinationConfig {
  canonicalRepository: string; sshTarget: string; destinationId: string; deployMode: 'stand' | 'prod';
  paymentRole: 'ci' | 'stand' | 'prod'; siteUrl: string; actor: string; webRoot: string;
  knownHostsFile: string; keepReleases: number; chatLoaderSrc: string; demoForms?: string;
  payment?: { endpoint: string; mode: 'test' | 'prod'; shopId: string; siteOrigin: string };
}
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
export function protectedFile(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('untrusted-config');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('untrusted-config');
  return realpathSync(path);
}
function publicUrl(value: unknown, originOnly = false): string {
  if (typeof value !== 'string') throw new Error('untrusted-config');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (originOnly && (url.pathname !== '/' || url.search))) throw new Error('untrusted-config');
  return value;
}
export function readConfig(path: string): DestinationConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as DestinationConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.canonicalRepository !== 'string' || !config.canonicalRepository || config.canonicalRepository.startsWith('-') ||
      typeof config.sshTarget !== 'string' || !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.:[\]-]*$/.test(config.sshTarget) || config.sshTarget.startsWith('root@') ||
      typeof config.destinationId !== 'string' || !config.destinationId.trim() ||
      !['stand', 'prod'].includes(config.deployMode) || !['ci', 'stand', 'prod'].includes(config.paymentRole) ||
      typeof config.actor !== 'string' || !config.actor.trim() ||
      typeof config.webRoot !== 'string' || !isAbsolute(config.webRoot) || config.webRoot === '/' || config.webRoot.includes('\0') ||
      !Number.isSafeInteger(config.keepReleases) || config.keepReleases < 5 ||
      typeof config.chatLoaderSrc !== 'string' || !config.chatLoaderSrc.trim() ||
      (config.demoForms !== undefined && (typeof config.demoForms !== 'string' || !config.demoForms.trim()))) throw new Error('untrusted-config');
  if (config.canonicalRepository.includes('://')) {
    const remote = new URL(config.canonicalRepository);
    if (!['https:', 'ssh:', 'file:'].includes(remote.protocol) || remote.password ||
        (remote.protocol !== 'ssh:' && remote.username)) throw new Error('untrusted-config');
  }
  if (config.deployMode === 'prod' && config.demoForms === 'stub') throw new Error('untrusted-config');
  publicUrl(config.siteUrl, true);
  if (config.chatLoaderSrc !== 'none') publicUrl(config.chatLoaderSrc);
  protectedFile(config.knownHostsFile);
  if (config.paymentRole !== 'ci') {
    const payment = config.payment;
    const expected = config.paymentRole === 'stand' ? { mode: 'test', shopId: '1440249' } : { mode: 'prod', shopId: '409285' };
    if (!payment || payment.mode !== expected.mode || payment.shopId !== expected.shopId) throw new Error('untrusted-config');
    publicUrl(payment.endpoint); publicUrl(payment.siteOrigin, true);
    // The preflight probes CORS for this origin; a different origin would approve a destination the published site cannot use.
    if (new URL(payment.siteOrigin).origin !== new URL(config.siteUrl).origin) throw new Error('untrusted-config');
  }
  return config;
}
export function artifactFiles(root: string): string[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid artifact directory');
  const result: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink in artifact');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result.push(relative(root, path));
      else throw new Error('nonregular artifact member');
    }
  }
  walk(root); return result;
}

