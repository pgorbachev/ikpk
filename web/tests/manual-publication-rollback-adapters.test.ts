import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRollbackCheckPorts } from '../scripts/lib/publication-check-adapters.ts';
import type { RollbackCheckContext } from '../scripts/lib/publication-rollback-checks.ts';
import { adapterFixture, CANARY } from './helpers/publication-adapter-fixtures.ts';

const fixtures: Awaited<ReturnType<typeof adapterFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.clean(); });
async function fixture() {
  const f = await adapterFixture(); fixtures.push(f);
  rmSync(f.options.snapshotDir, { recursive: true }); rmSync(f.options.ledgerDir, { recursive: true });
  const treeDir = join(f.temp, 'downloaded-retained-release'); mkdirSync(treeDir);
  writeFileSync(join(treeDir, 'index.html'), '<main>retained bytes</main>');
  const context: RollbackCheckContext = { commit: f.context.commit, snapshotId: f.context.snapshotId,
    destinationId: f.context.destinationId, deployMode: 'stand', paymentRole: 'ci', treeDir,
    reportPath: f.context.reportPath, env: { PATH: process.env.PATH, HOME: join(f.temp, 'home'), TMPDIR: join(f.temp, 'home'), DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'none' } };
  const options = { webRoot: f.options.webRoot, treeDir, reportsDir: f.options.reportsDir };
  // Reporter fixture follows whichever fixed trusted smoke suite the adapter owns.
  const runtime = { ...f.runtime, async run(command: Parameters<typeof f.runtime.run>[0]) {
    const result = await f.runtime.run(command);
    if (command.file.endsWith('/playwright') && !f.state.omitReport) {
      writeFileSync(command.env.PLAYWRIGHT_JSON_OUTPUT_NAME!, f.state.rawReport ?? JSON.stringify(f.state.browser));
    }
    return result;
  } };
  return { ...f, context, options, runtime };
}

describe('installed retained check adapter: fixed trusted tools over downloaded immutable bytes', () => {
  it('runs destination, browser and ci absence outside web/dist with no snapshot or source dependency', async () => {
    const f = await fixture(); const ports = createRollbackCheckPorts(f.options, f.runtime);
    const before = await ports.digest(f.context.treeDir);
    expect(await ports.checkDestination(f.context)).toEqual({ conclusion: 'success', executedTests: 3 });
    expect(await ports.checkBrowser(f.context)).toEqual({ conclusion: 'success', executedTests: 4 });
    expect(await ports.checkPaymentAbsent(f.context)).toEqual({ conclusion: 'success', executedTests: 3 });
    expect(await ports.digest(f.context.treeDir)).toBe(before);
    expect(f.commands).toHaveLength(3);
    expect(f.commands[0].args).toContain('tests/publication/destination.test.ts');
    expect(f.commands[2].args).toContain('tests/publication/payment-absence.test.ts');
    for (const command of f.commands) {
      expect(command.cwd).toBe(f.options.webRoot);
      expect(command.file.startsWith(join(f.options.webRoot, 'node_modules/.bin/'))).toBe(true);
      expect(realpathSync(command.env.PUBLICATION_TREE_DIR!)).toBe(realpathSync(f.context.treeDir));
      expect(command.env.CONTENT_SNAPSHOT_DIR).toBeUndefined();
      expect(command.env.PUBLICATION_LEDGER_DIR).toBeUndefined();
      expect(command.env.CMS_URL).toBeUndefined();
      expect(command.args.join(' ')).not.toMatch(/capture-content|tests\/publication\/(?:snapshot|build)\.test|--passWithNoTests/);
    }
    expect(f.previews).toHaveLength(1); expect(realpathSync(f.previews[0].treeDir)).toBe(realpathSync(f.context.treeDir)); expect(f.state.closed).toBe(1);
    expect(f.commands[1].args).toContain('--project=desktop'); expect(f.commands[1].args).toContain('--project=mobile');
    expect(f.commands[1].args).toContain('--reporter=json');
    expect(f.commands[1].env.PUBLICATION_BASE_URL).toBe('http://127.0.0.1:47321');
    expect(ports).not.toHaveProperty('capture'); expect(ports).not.toHaveProperty('build');
  });

  it('pins the downloaded tree before commands and refuses a substituted context', async () => {
    const f = await fixture(); const ports = createRollbackCheckPorts(f.options, f.runtime);
    f.context.treeDir = join(f.options.webRoot, 'dist');
    for (const method of ['checkDestination', 'checkBrowser', 'checkPaymentAbsent'] as const) await expect(ports[method](f.context)).rejects.toThrow();
    expect(f.commands).toEqual([]); expect(f.previews).toEqual([]);
  });

  it('refuses reports under the retained tree through direct paths or a symlink alias', async () => {
    for (const alias of [false, true]) {
      const f = await fixture(); const parent = alias ? join(f.temp, 'alias') : f.context.treeDir;
      if (alias) symlinkSync(f.context.treeDir, parent);
      expect(() => createRollbackCheckPorts({ ...f.options, reportsDir: join(parent, 'reports') }, f.runtime)).toThrow();
      expect(f.commands).toEqual([]);
    }
  });

  it('ci strips credentials and payment config and refuses active probes before runtime effects', async () => {
    const f = await fixture(); Object.assign(f.context.env, { CONTENT_SNAPSHOT_DIR: CANARY, CMS_TOKEN: CANARY, GH_TOKEN: CANARY, SSH_AUTH_SOCK: CANARY, NODE_OPTIONS: CANARY, PUBLICATION_PAYMENT_ENDPOINT: CANARY });
    const ports = createRollbackCheckPorts(f.options, f.runtime);
    await ports.checkPaymentAbsent(f.context); await ports.checkBrowser(f.context);
    expect(JSON.stringify(f.commands)).not.toContain(CANARY); expect(JSON.stringify(f.previews)).not.toContain(CANARY);
    for (const command of f.commands) expect(Object.keys(command.env).filter((key) => key.startsWith('PUBLICATION_PAYMENT_'))).toEqual([]);
    const before = f.commands.length;
    await expect(ports.checkPaymentReadiness(f.context)).rejects.toThrow(); await expect(ports.checkPaymentPreflight(f.context)).rejects.toThrow();
    expect(f.commands).toHaveLength(before);
  });

  it('failed, skipped, zero or missing actual reporter evidence cannot become a rollback verdict', async () => {
    for (const fault of ['process', 'skipped', 'zero', 'missing'] as const) {
      const f = await fixture();
      if (fault === 'process') f.state.exitCode = 1;
      if (fault === 'skipped') f.state.reports.destination.testResults[0].assertionResults[0].status = 'pending';
      if (fault === 'zero') { f.state.reports.destination.numTotalTests = 0; f.state.reports.destination.numPassedTests = 0; f.state.reports.destination.testResults = []; }
      if (fault === 'missing') f.state.omitReport = true;
      await expect(createRollbackCheckPorts(f.options, f.runtime).checkDestination(f.context)).rejects.toThrow();
    }
  });

  it('closes retained preview even if browser evidence is incomplete', async () => {
    const f = await fixture(); f.state.browser.stats.skipped = 1;
    await expect(createRollbackCheckPorts(f.options, f.runtime).checkBrowser(f.context)).rejects.toThrow();
    expect(f.previews).toHaveLength(1); expect(f.state.closed).toBe(1);
  });

  it('never executes scripts carried in the retained release or uses it as process cwd', async () => {
    const f = await fixture(); writeFileSync(join(f.context.treeDir, 'package.json'), '{"scripts":{"test":"exit 0"}}');
    const ports = createRollbackCheckPorts(f.options, f.runtime);
    await ports.checkDestination(f.context); await ports.checkBrowser(f.context);
    for (const command of f.commands) {
      expect(relative(f.context.treeDir, resolve(command.cwd))).toMatch(/^\.\./);
      expect(relative(f.context.treeDir, resolve(command.file))).toMatch(/^\.\./);
      expect(command.args).not.toContain(join(f.context.treeDir, 'package.json'));
    }
    expect(readFileSync(join(f.context.treeDir, 'package.json'), 'utf8')).toContain('exit 0');
  });
});
