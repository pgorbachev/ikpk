import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { stripShellComments } from './workflows';

// One implementation, including its private worker/transport edges. These are not
// exceptions for other publishers: an additional capability in any member is still
// inspected. Native launcher/worker/transport tests prove authorization semantics;
// this configuration audit only recognizes the literal capabilities below.
const publication = {
  id: 'scripts/publication-launcher.mjs',
  wrapper: 'scripts/deploy-web.sh',
  worker: 'web/scripts/publication-worker.ts',
  operator: 'web/scripts/publication-operator.ts',
  transport: 'scripts/publication-transport.mjs',
  remote: 'scripts/lib/publication-remote.py',
};
const ignoredDirectories = new Set(['.git', 'node_modules', '.astro', '.cache', 'dist', 'dist-demo',
  'dist-stand', 'coverage', 'test-results', 'playwright-report', 'tests', '__tests__', 'fixtures']);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function files(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : files(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}

function clean(source: string, name: string): string {
  // Shell/Python full-line comments are not commands. JS block/line comments are
  // removed without stripping URL strings; this is deliberately not a shell parser.
  return /\.[cm]?[jt]s$/.test(name)
    ? source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    : stripShellComments(source);
}
function capabilities(source: string): string[] {
  const out: string[] = [];
  // Explicit web artifact transfer; ordinary CMS deployment and backup reads are
  // separate subjects. A current-pointer write is publication even without SSH.
  if (/\b(?:rsync|scp|sftp)\b[^\n]*(?:web\/dist|[^\s]+:[^\s]*\/releases)/.test(source)) out.push('web-transfer');
  if (/\b(?:ln|mv|cp|rsync)\s[^\n]*(?:\$\{?WEB_ROOT\}?\/current|\/var\/www\/[^\s]+\/current)/.test(source)) out.push('current-write');
  if (/\bspawnSync\s*\(/.test(source) && /\bbrokerCredentials\s*\(/.test(source) && /scripts\/deploy-web\.sh/.test(source)) out.push('launcher');
  if (/\bspawn\s*\(/.test(source) && /publication-remote\.py/.test(source)) out.push('transport');
  if (/class PublicationSession\b/.test(source) && /os\.replace\(/.test(source)) out.push('remote');
  return out;
}

/** Known-literal executable/configuration inventory, not arbitrary-program proof.
 * The separate hosted configuration gate audits action and credential policies.
 * Renamed executable files and all npm lifecycle commands are included here.
 */
export function inventoryPublicationEntrypoints(root: string): string[] {
  root = resolve(root);
  const all = files(root), problems = new Set<string>();
  const read = (name: string) => readFileSync(join(root, name), 'utf8');
  for (const name of Object.values(publication))
    if (!existsSync(join(root, name)) || !lstatSync(join(root, name)).isFile()) problems.add(`missing publication member: ${name}`);
  for (const [kind, name] of [['launcher', publication.id], ['transport', publication.transport], ['remote', publication.remote]])
    if (existsSync(join(root, name)) && !capabilities(clean(read(name), name)).includes(kind)) problems.add(`inactive publication member: ${name}`);

  const privateMembers = [publication.wrapper, publication.worker, publication.operator, publication.transport, publication.remote];
  const permittedCalls = new Map([
    [publication.id, [publication.wrapper, publication.operator]],
    [publication.wrapper, [publication.worker]],
  ]);
  function inspect(source: string, name: string, cwd: string, hosted = false, seen = new Set<string>()) {
    const text = clean(source, name);
    for (const capability of capabilities(text)) {
      const owner = capability === 'launcher' ? publication.id : capability === 'transport' ? publication.transport :
        capability === 'remote' ? publication.remote : undefined;
      if (hosted || name !== owner) problems.add(`${name}: ${capability}`);
    }
    for (const member of privateMembers) {
      // Invocation, not imports/type references. A wrapper cannot create another
      // implementation, but exposing a private worker bypasses the launcher contract.
      const invoked = new RegExp(`(?:node|tsx|bash|sh|python3?|exec)\\s+[^\\n;&|]*${basename(member).replaceAll('.', '\\.')}\\b`).test(text);
      if (invoked && (hosted || !permittedCalls.get(name)?.includes(member))) problems.add(`${name}: private entrypoint ${member}`);
    }
    if (hosted && (text.includes(publication.id) || /\b(?:rsync|scp|sftp|ssh)\s/.test(text))) problems.add(`${name}: hosted publication`);
    if (hosted) for (const match of text.matchAll(/\bnpm\s+(?:run\s+)?([\w:-]+)/g)) {
      const path = join(cwd, 'package.json'), key = `${path}#${match[1]}`;
      if (!existsSync(path) || seen.has(key)) continue;
      seen.add(key);
      const scripts = record(record(JSON.parse(readFileSync(path, 'utf8'))).scripts);
      for (const command of [`pre${match[1]}`, match[1], `post${match[1]}`])
        if (typeof scripts[command] === 'string') inspect(scripts[command], `${relative(root, path)}#${command}`, cwd, true, seen);
    }
    // Follow literal script invocations, including non-executable npm wrappers.
    for (const match of text.matchAll(/(?:^|[\s;&|])(?:bash\s+|sh\s+|node\s+|tsx\s+|python3?\s+)?([.\w/-]+\.(?:sh|[cm]?[jt]s|py))\b/g)) {
      const path = resolve(cwd, match[1]), rel = relative(root, path);
      if (rel.startsWith('..') || !existsSync(path) || !lstatSync(path).isFile() || seen.has(path)) continue;
      seen.add(path);
      inspect(readFileSync(path, 'utf8'), rel, cwd, hosted, seen);
    }
  }
  for (const name of all) {
    if (name.endsWith('package.json')) {
      for (const [command, source] of Object.entries(record(record(JSON.parse(read(name))).scripts)))
        if (typeof source === 'string') inspect(source, `${name}#${command}`, dirname(join(root, name)));
      continue;
    }
    const executable = (lstatSync(join(root, name)).mode & 0o111) !== 0;
    if (executable || (/(?:^|\/)(?:scripts|bin)\//.test(name) && /(?:\.(?:sh|[cm]?[jt]s|py)$|(?:^|\/)bin\/[^.]+$)/.test(name)))
      inspect(read(name), name, root);
  }
  const workflows = all.filter((name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name));
  if (!workflows.length) problems.add('missing hosted inventory');
  for (const name of workflows) {
    const doc = record(parse(read(name)));
    if (!Object.keys(record(doc.jobs)).length) problems.add(`${name}: missing jobs`);
    const visit = (value: unknown, cwd: string) => {
      if (Array.isArray(value)) { value.forEach((item) => visit(item, cwd)); return; }
      const node = record(value);
      const dir = node['working-directory'] ?? record(record(node.defaults).run)['working-directory'];
      if (typeof dir === 'string') cwd = resolve(root, dir);
      for (const [key, item] of Object.entries(node)) {
        if (['run', 'script'].includes(key) && typeof item === 'string') inspect(item, name, cwd, true);
        if (key === 'uses' && typeof item === 'string' && /(?:deploy-pages|upload-pages-artifact|scp-action|ssh-action)/.test(item)) problems.add(`${name}: hosted publisher action`);
        if (item && typeof item === 'object') visit(item, cwd);
      }
    };
    visit(doc, root);
  }
  if (problems.size) throw new Error(`publication-entrypoints: declared ${publication.id}; ${[...problems].sort().join('; ')}`);
  return [publication.id];
}
