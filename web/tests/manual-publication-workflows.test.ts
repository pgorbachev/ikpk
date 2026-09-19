import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT, requiredTestWorkflows, loadWorkflows, stripShellComments } from './helpers/workflows';

type Document = Record<string, unknown>;
type Source = { file: string; doc: Document };
const record = (v: unknown): Document => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Document : {};
function parseWorkflows(files: { file: string; text: string }[]): Source[] {
  if (!files.length) throw new Error('no workflow configurations');
  return files.map(({ file, text }) => {
    const doc = record(parse(text));
    if (!Object.keys(record(doc.jobs)).length) throw new Error(`${file}: no jobs`);
    return { file, doc };
  });
}
function repositoryWorkflows(): Source[] {
  const dir = join(REPO_ROOT, '.github/workflows');
  return parseWorkflows(readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') })));
}
// Configuration audit only: YAML, npm lifecycle hooks, literal shell calls and actions.
// Arbitrary JS/Python semantics and secrets stored remotely require independent acceptance.
// Newly introduced external actions/secret references require explicit review.
const NON_PUBLISHING_ACTIONS = new Set([
  'actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact',
  'actions/github-script', 'dependabot/fetch-metadata', 'gitleaks/gitleaks-action',
  'pgorbachev/ikpk/.github/workflows/dependabot-auto-merge-policy.yml',
  'pgorbachev/ikpk/.github/workflows/dependabot-rebase-policy.yml',
]);
const NON_DEPLOY_SECRETS = new Set(['GITHUB_TOKEN', 'CMS_TOKEN', 'CMS_URL']);
const TRANSFER = /(?:^|[\s;&|(/])(?:rsync|scp|sftp|ssh)(?:\s|$)|(?:deploy-web|publish-web)\.sh\b|\bgh\s+workflow\s+run\b/m;
const PUBLICATION_STATE = /\bpublication-cli\.(?:ts|js)\s+(?:reconcile|record-pair|merge-pairs)\b|\bpublication:(?:reconcile|record-pair|merge-pairs)\b/;
type ReadSource = (file: string) => string | undefined;
const readSource: ReadSource = (file) => existsSync(file) ? readFileSync(file, 'utf8') : undefined;
function commands(text: string, cwd: string, read: ReadSource, seen = new Set<string>()): string[] {
  const clean = stripShellComments(text), out = [clean];
  for (const match of clean.matchAll(/\bnpm\s+(?:run\s+)?([\w:-]+)/g)) {
    const key = `${cwd}:${match[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = read(join(cwd, 'package.json'));
    if (!pkg) continue;
    const scripts = record(record(JSON.parse(pkg)).scripts);
    for (const name of [`pre${match[1]}`, match[1], `post${match[1]}`])
      if (typeof scripts[name] === 'string') out.push(...commands(scripts[name], cwd, read, seen));
  }
  for (const match of clean.matchAll(/(?:^|[\s;&|])(?:bash\s+|sh\s+|source\s+)?([.\w/-]+\.sh)\b/g)) {
    const path = resolve(cwd, match[1]);
    if (seen.has(path)) continue;
    seen.add(path);
    const source = read(path);
    if (source !== undefined) out.push(...commands(source, cwd, read, seen));
  }
  return out;
}
function findings(sources: Source[], read: ReadSource = readSource): string[] {
  if (!sources.length) throw new Error('no workflow configurations');
  const out: string[] = [];
  const visit = (value: unknown, path: string, cwd: string, tests: boolean): void => {
    if (Array.isArray(value)) { value.forEach((item, i) => visit(item, `${path}[${i}]`, cwd, tests)); return; }
    if (typeof value !== 'object' || value === null) return;
    const node = record(value);
    const defaults = record(record(node.defaults).run)['working-directory'];
    const dir = node['working-directory'] ?? defaults;
    const workingDir = typeof dir === 'string' ? resolve(REPO_ROOT, dir) : cwd;
    for (const [key, item] of Object.entries(node)) {
      const at = `${path}.${key}`;
      if (key === 'permissions') {
        const perms = record(item);
        if (item === 'write-all' || perms.pages === 'write' || perms['id-token'] === 'write') out.push(`${at}: publication privilege`);
        if (tests && (item === 'write-all' || perms.contents === 'write')) out.push(`${at}: Tests writes repository`);
      }
      if (key === 'environment' && (item === 'github-pages' || record(item).name === 'github-pages')) out.push(`${at}: Pages environment`);
      if (key === 'concurrency' && (item === 'pages' || record(item).group === 'pages')) out.push(`${at}: Pages concurrency`);
      if (key === 'uses' && typeof item === 'string' && !NON_PUBLISHING_ACTIONS.has(item.split('@')[0])) out.push(`${at}: unreviewed action ${item}`);
      if (key === 'secrets' && item === 'inherit') out.push(`${at}: unbounded inherited credentials`);
      if (key === 'publication-record' && tests) out.push(`${at}: publication job in Tests`);
      if ((key === 'run' || key === 'script') && typeof item === 'string') {
        for (const command of commands(item, workingDir, read)) {
          if (TRANSFER.test(command)) out.push(`${at}: hosted transfer or remote dispatch`);
          if (tests && PUBLICATION_STATE.test(command)) out.push(`${at}: publication state in Tests`);
        }
      }
      if (key === 'env' || key === 'with' || key === 'secrets')
        for (const field of Object.keys(record(item)))
          if (/(?:^|_)(?:VPS|SSH|PRIVATE_KEY|KNOWN_HOSTS)(?:_|$)/i.test(field)) out.push(`${at}.${field}: deployment configuration`);
      if (typeof item === 'string')
        for (const secret of item.matchAll(/secrets(?:\.([A-Za-z_][\w]*)|\[['"]([^'"]+)['"]\])/g))
          if (!NON_DEPLOY_SECRETS.has(secret[1] ?? secret[2])) out.push(`${at}: unreviewed secret ${secret[1] ?? secret[2]}`);
      visit(item, at, workingDir, tests);
    }
  };
  for (const { file, doc } of sources) visit(doc, file, REPO_ROOT, doc.name === 'Tests');
  return out;
}
function fixture(extra: Document = {}): Source[] {
  return [{ file: 'test.yml', doc: {
    name: 'Tests', on: { push: { branches: ['main'] }, schedule: [{ cron: '0 0 * * *' }], repository_dispatch: { types: ['cms-content-changed'] } },
    permissions: { contents: 'read' }, jobs: { checks: { steps: [{ run: 'npm test', 'working-directory': 'web' }] } }, ...extra,
  } }];
}
describe('manual publication: hosted configuration', () => {
  it('all parsed workflows contain no hosted publication capability', () => {
    const sources = repositoryWorkflows();
    expect(sources.length).toBeGreaterThan(0);
    expect(findings(sources)).toEqual([]);
  });
  it.each(['push', 'schedule', 'repository_dispatch', 'workflow_run', 'workflow_dispatch'])('%s cannot publish, including a successful upstream run', (event) => {
    const all = repositoryWorkflows();
    const sources = all.filter(({ doc }) => Object.hasOwn(record(doc.on), event));
    // Some events may disappear altogether; the complete parsed input remains nonempty.
    expect(all.length).toBeGreaterThan(0);
    expect(sources.length ? findings(sources) : []).toEqual([]);
  });
  it('Tests records a verdict without publication-record, reconciliation or write credentials', () => {
    const sources = repositoryWorkflows().filter(({ doc }) => doc.name === 'Tests');
    expect(sources).toHaveLength(1);
    expect(findings(sources)).toEqual([]);
  });
});
describe('hosted configuration gate: targeted negative fixtures', () => {
  it('rejects absent, invalid and semantically empty configurations', () => {
    expect(() => parseWorkflows([])).toThrow('no workflow');
    expect(() => parseWorkflows([{ file: 'broken.yml', text: 'jobs: [' }])).toThrow();
    expect(() => parseWorkflows([{ file: 'empty.yml', text: '# comment' }])).toThrow('no jobs');
  });
  it('accepts checks and unrelated workflow_run receivers', () => {
    expect(findings(fixture({ on: { workflow_run: { workflows: ['Tests'], types: ['completed'] } } }), () => undefined)).toEqual([]);
  });
  it.each([
    ['Pages action', { jobs: { upload: { steps: [{ uses: 'actions/upload-pages-artifact@v5' }] } } }],
    ['direct transport', { jobs: { send: { steps: [{ run: 'rsync -a web/dist/ operator@host:/releases/new/' }] } } }],
    ['guarded transport', { jobs: { send: { if: 'false', steps: [{ run: 'scp -r web/dist host:/releases' }] } } }],
    ['reusable remote publisher', { jobs: { send: { uses: 'example/publish/.github/workflows/release.yml@main' } } }],
    ['job Pages rights', { jobs: { check: { permissions: { pages: 'write' } } } }],
    ['workflow id-token', { permissions: { 'id-token': 'write' } }],
    ['write-all', { permissions: 'write-all' }],
    ['Pages environment', { jobs: { check: { environment: { name: 'github-pages' } } } }],
    ['Pages concurrency', { concurrency: { group: 'pages' } }],
    ['workflow credential', { env: { SSH_KEY: '${{ secrets.PROD_KEY }}' } }],
    ['job credential', { jobs: { check: { env: { KEY: "${{ secrets['PROD_KEY'] }}" } } } }],
    ['step credential', { jobs: { check: { steps: [{ with: { key: '${{ secrets.PROD_KEY }}' } }] } } }],
    ['inherited credentials', { jobs: { check: { secrets: 'inherit' } } }],
    ['renamed record job', { jobs: { renamed: { steps: [{ run: 'npx tsx scripts/publication-cli.ts record-pair --commit abc' }] } } }],
    ['renamed reconcile step', { jobs: { checks: { steps: [{ run: 'npm run publication:reconcile' }] } } }],
  ])('rejects %s after renaming the workflow file', (_name, mutation) => {
    const bad = fixture(mutation); bad[0].file = 'renamed.yaml';
    expect(findings(bad, () => undefined).length).toBeGreaterThan(0);
  });
  it('follows npm lifecycle and shell wrappers to the transport', () => {
    const files = new Map([
      [join(REPO_ROOT, 'web/package.json'), JSON.stringify({ scripts: { pretest: 'bash ../scripts/push-output.sh', test: 'vitest run' } })],
      [join(REPO_ROOT, 'scripts/push-output.sh'), 'rsync -a web/dist/ host:/releases/new'],
    ]);
    expect(findings(fixture(), (file) => files.get(file))).toContain('test.yml.jobs.checks.steps[0].run: hosted transfer or remote dispatch');
  });
  it('does not treat comments as deployment', () => {
    expect(findings(fixture({ jobs: { check: { steps: [{ run: '# rsync web/dist/ host:/releases\nnpm test' }] } } }), () => undefined)).toEqual([]);
  });
  it('requires one real Tests without inferring it from a publisher', () => {
    const tests = requiredTestWorkflows(loadWorkflows());
    expect(requiredTestWorkflows(tests)).toEqual(tests);
    expect(() => requiredTestWorkflows([])).toThrow();
    expect(() => requiredTestWorkflows([{ ...tests[0], displayName: 'Renamed' }])).toThrow();
    expect(() => requiredTestWorkflows([...tests, ...tests])).toThrow();
    expect(() => requiredTestWorkflows([{ ...tests[0], jobs: {} }])).toThrow();
  });
});
