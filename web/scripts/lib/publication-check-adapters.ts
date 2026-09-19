import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestTree } from '../../../scripts/publication-launcher.mjs';
import { publicationObservation, readPublicationSnapshot } from './publication-snapshot.ts';
import type { CheckResult, PublicationCheckContext } from './publication-checks.ts';
import type { PublicationCheckPorts } from './publication-checks.ts';

export interface PublicationCommand {
  file: string; args: string[]; cwd: string; env: Record<string, string | undefined>;
}
export interface PublicationProcessResult { exitCode: number | null; signal?: string | null }
export interface PublicationPreview {
  baseUrl: string;
  close(): Promise<void>;
}
export interface PublicationAdapterRuntime {
  run(command: PublicationCommand): Promise<PublicationProcessResult>;
  startPreview(input: { treeDir: string; env: Record<string, string | undefined> }): Promise<PublicationPreview>;
}
export interface PublicationAdapterOptions {
  webRoot: string; snapshotDir: string; reportsDir: string; ledgerDir: string;
  captureEnv: Record<string, string | undefined>;
  payment?: { endpoint: string; readinessUrl: string; mode: 'test' | 'prod'; shopId: string; siteOrigin: string };
}


export const PUBLICATION_BROWSER_ARGS = ['test', 'tests/publication-smoke.spec.ts', '--config', 'playwright.publication.config.ts', '--project=desktop', '--project=mobile', '--reporter=json'] as const;
const safeNames = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'DEMO_FORMS', 'CHAT_LOADER_SRC'] as const;
const defaultPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
function safeEnv(source: Record<string, string | undefined>) {
  return { PATH: defaultPath, ...Object.fromEntries(safeNames.filter((name) => source[name] !== undefined).map((name) => [name, source[name]])) };
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonical(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
}
function treeFiles(root: string): string[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid artifact directory');
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink in artifact');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
      else throw new Error('nonregular artifact member');
    }
  }
  walk(root); return files;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain' };
const defaultRuntime: PublicationAdapterRuntime = {
  run(command) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, stdio: 'ignore', shell: false });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
    });
  },
  async startPreview({ treeDir }) {
    const root = realpathSync(treeDir);
    const server = createServer((request, response) => {
      try {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
        let path = resolve(root, `.${pathname}`);
        if (!inside(root, path)) { response.writeHead(403).end(); return; }
        if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
        else if (!existsSync(path) && existsSync(`${path}.html`)) path += '.html';
        if (!existsSync(path) || !inside(root, realpathSync(path)) || !statSync(path).isFile()) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : readFileSync(path));
      } catch { response.writeHead(400).end(); }
    });
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('preview address unavailable');
    return { baseUrl: `http://127.0.0.1:${address.port}`, async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    } };
  },
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid reporter object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('invalid reporter array');
  return value;
}
function vitestResult(value: unknown): CheckResult {
  const report = object(value);
  const assertions = array(report.testResults).flatMap((suite) => {
    const result = object(suite);
    if (result.status !== 'passed') throw new Error('Vitest suite did not pass');
    return array(result.assertionResults);
  });
  if (!assertions.length || assertions.some((test) => object(test).status !== 'passed') || report.success !== true ||
      report.numTotalTests !== assertions.length || report.numPassedTests !== assertions.length ||
      report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) throw new Error('incomplete Vitest evidence');
  return { conclusion: 'success', executedTests: assertions.length };
}
function playwrightResult(value: unknown): CheckResult {
  const report = object(value); const stats = object(report.stats);
  const projects = new Set<string>(); let count = 0;
  function visit(suites: unknown[]) {
    for (const raw of suites) {
      const suite = object(raw);
      for (const rawSpec of array(suite.specs ?? [])) {
        const spec = object(rawSpec);
        if (spec.ok !== true) throw new Error('browser spec failed');
        for (const rawTest of array(spec.tests)) {
          const test = object(rawTest); const results = array(test.results);
          if (!['desktop', 'mobile'].includes(String(test.projectName)) || test.expectedStatus !== 'passed' || test.status !== 'expected' ||
              results.length !== 1 || object(results[0]).status !== 'passed' || object(results[0]).retry !== 0) throw new Error('incomplete browser test');
          projects.add(String(test.projectName)); count++;
        }
      }
      visit(array(suite.suites ?? []));
    }
  }
  visit(array(report.suites));
  if (!count || projects.size !== 2 || array(report.errors).length || stats.expected !== count ||
      stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0) throw new Error('incomplete browser evidence');
  return { conclusion: 'success', executedTests: count };
}

/** Installed-worker API: operator data cannot select commands, assertions or runtime effects. */
export function createPublicationCheckPorts(options: PublicationAdapterOptions, runtime = defaultRuntime): PublicationCheckPorts {
  const webRoot = resolve(options.webRoot); const output = join(webRoot, 'dist');
  if (inside(canonical(output), canonical(options.reportsDir))) throw new Error('reports inside artifact');
  function contextEnv(context: PublicationCheckContext) {
    if (canonical(context.treeDir) !== canonical(output) || canonical(context.snapshotDir) !== canonical(options.snapshotDir)) throw new Error('foreign publication tree or snapshot');
    const env: Record<string, string | undefined> = { ...safeEnv(context.env), CONTENT_SNAPSHOT_DIR: options.snapshotDir,
      DEPLOY_MODE: context.deployMode, PAYMENT_ROLE: context.paymentRole, PUBLICATION_TREE_DIR: output,
      PUBLICATION_LEDGER_DIR: options.ledgerDir, PUBLICATION_DESTINATION_ID: context.destinationId,
      PUBLICATION_COMMIT: context.commit, PUBLICATION_SNAPSHOT_ID: context.snapshotId,
      PUBLICATION_CHROMIUM_EXECUTABLE: chromium.executablePath() };
    if (context.paymentRole !== 'ci') {
      const payment = options.payment;
      if (!payment || !payment.endpoint || !payment.readinessUrl || !payment.shopId || !payment.siteOrigin || !['test', 'prod'].includes(payment.mode)) throw new Error('missing payment destination configuration');
      Object.assign(env, { [`PAYMENT_ENDPOINT_${context.paymentRole.toUpperCase()}`]: payment.endpoint,
        PUBLICATION_PAYMENT_ENDPOINT: payment.endpoint, PUBLICATION_PAYMENT_READY_URL: payment.readinessUrl,
        PUBLICATION_PAYMENT_MODE: payment.mode, PUBLICATION_PAYMENT_SHOP_ID: payment.shopId, PUBLICATION_PAYMENT_SITE_ORIGIN: payment.siteOrigin });
    }
    return env;
  }
  async function run(file: string, args: string[], env: Record<string, string | undefined>) {
    const result = await runtime.run({ file, args, cwd: webRoot, env });
    if (result.exitCode !== 0 || result.signal) throw new Error('publication check process did not complete successfully');
  }
  function reportPath(stage: string) {
    const path = join(options.reportsDir, `${stage}.json`);
    if (existsSync(path)) throw new Error('publication report already exists');
    mkdirSync(options.reportsDir, { recursive: true }); return path;
  }
  async function suite(stage: string, context: PublicationCheckContext) {
    const env = contextEnv(context); const path = reportPath(stage);
    await run(join(webRoot, 'node_modules/.bin/vitest'), ['run', '--config', 'vitest.publication.config.ts', `tests/publication/${stage}.test.ts`, '--reporter=json', `--outputFile=${path}`], env);
    return vitestResult(JSON.parse(readFileSync(path, 'utf8')));
  }
  return {
    async capture() {
      const source = options.captureEnv.CMS_URL ?? options.captureEnv.STRAPI_URL;
      if (!source) throw new Error('live CMS URL required');
      const env = { ...safeEnv(options.captureEnv), ...Object.fromEntries(['CMS_URL', 'STRAPI_URL', 'CMS_TOKEN', 'STRAPI_API_TOKEN'].filter((name) => options.captureEnv[name] !== undefined).map((name) => [name, options.captureEnv[name]])), CONTENT_SNAPSHOT_DIR: options.snapshotDir };
      rmSync(join(options.snapshotDir, 'snapshot.json'), { force: true });
      await run(join(webRoot, 'node_modules/.bin/tsx'), ['scripts/capture-content-snapshot.ts'], env);
      const snapshot = readPublicationSnapshot(options.snapshotDir);
      if (new URL(snapshot.origin!.url!).href !== new URL(source).href) throw new Error('foreign capture origin');
      snapshot.provenance = await publicationObservation(snapshot, options.ledgerDir);
      writeFileSync(join(options.snapshotDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
      return { snapshotId: snapshot.snapshotId!, snapshotDir: options.snapshotDir };
    },
    async build(context) { await run('npm', ['run', 'build'], contextEnv(context)); },
    checkSnapshot: (context) => suite('snapshot', context),
    checkBuild: (context) => suite('build', context),
    checkDestination: (context) => suite('destination', context),
    checkPaymentAbsent: (context) => { if (context.paymentRole !== 'ci') throw new Error('payment absence requires ci role'); return suite('payment-absence', context); },
    checkPaymentReadiness: (context) => { if (context.paymentRole === 'ci') throw new Error('ci must not contact payment API'); return suite('payment-readiness', context); },
    checkPaymentPreflight: (context) => { if (context.paymentRole === 'ci') throw new Error('ci must not contact payment API'); return suite('payment-preflight', context); },
    async checkBrowser(context) {
      const env = contextEnv(context); const path = reportPath('browser');
      const preview = await runtime.startPreview({ treeDir: context.treeDir, env });
      try {
        await run(join(webRoot, 'node_modules/.bin/playwright'), [...PUBLICATION_BROWSER_ARGS],
          { ...env, PUBLICATION_BASE_URL: preview.baseUrl, PLAYWRIGHT_JSON_OUTPUT_NAME: path, PUBLICATION_BROWSER_OUTPUT: join(options.reportsDir, 'browser-output') });
        return playwrightResult(JSON.parse(readFileSync(path, 'utf8')));
      } finally { await preview.close(); }
    },
    digest: (treeDir) => digestTree(treeDir, treeFiles(treeDir)),
  };
}
