import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicationCheckPorts } from '../scripts/lib/publication-check-adapters.ts';
import { contentFingerprint, snapshotId } from '../scripts/lib/content-snapshot.ts';
import type { PublicationCommand } from '../scripts/lib/publication-check-adapters.ts';
import { adapterFixture, CANARY, type Stage } from './helpers/publication-adapter-fixtures.ts';

const fixtures: Awaited<ReturnType<typeof adapterFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.clean(); });
async function fixture() { const f = await adapterFixture(); fixtures.push(f); return f; }
function vitestCommand(command: PublicationCommand | undefined, stage: Stage, reportPath: string) {
  expect(command).toBeDefined();
  expect(command!.args).toContain('run');
  expect(command!.args).toContain('vitest.publication.config.ts');
  expect(command!.args).toContain(`tests/publication/${stage}.test.ts`);
  expect(command!.args).toContain('--reporter=json');
  expect(command!.args.join(' ')).toContain(reportPath);
  expect(command!.args.some((arg) => /test:build|test:stand|test:demo|--passWithNoTests/.test(arg))).toBe(false);
}

// These tests exercise the adapter boundary with controllable local process effects.
// The production assertion suites are a subsequent implementation task.
describe('publication production adapters: capture and one existing build', () => {
  it('refuses missing live CMS configuration before invoking any process', async () => {
    const f = await fixture(); f.options.captureEnv = { PATH: process.env.PATH };
    await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
  });

  it('one capture invokes the existing script once and returns its live identity bound to the matching journal', async () => {
    const f = await fixture(); const before = readdirSync(f.options.ledgerDir).map((name) => [name, readFileSync(join(f.options.ledgerDir, name), 'utf8')]);
    const result = await createPublicationCheckPorts(f.options, f.runtime).capture();
    expect(result).toEqual({ snapshotId: f.snapshot.snapshotId, snapshotDir: f.options.snapshotDir });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0].args.some((arg) => arg.endsWith('scripts/capture-content-snapshot.ts'))).toBe(true);
    expect(f.commands[0].env.CONTENT_SNAPSHOT_DIR).toBe(f.options.snapshotDir);
    expect(JSON.parse(readFileSync(join(f.options.snapshotDir, 'snapshot.json'), 'utf8')).provenance).toEqual({ observedEntry: 1, revision: 1, highWaterMark: 1 });
    expect(readdirSync(f.options.ledgerDir).map((name) => [name, readFileSync(join(f.options.ledgerDir, name), 'utf8')])).toEqual(before);
  });

  it('refuses pinned, foreign source, and malformed live capture identities', async () => {
    for (const mutation of ['pinned', 'foreign', 'identity'] as const) {
      const f = await fixture();
      if (mutation === 'pinned') f.snapshot.origin = { kind: 'pinned' };
      if (mutation === 'foreign') f.snapshot.origin!.url = 'https://another-cms.test.invalid';
      if (mutation === 'identity') f.snapshot.snapshotId = 'invented-not-a-fingerprint-derived-id';
      await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow();
    }
  });

  it('does not accept snapshot bytes after failed or signalled capture', async () => {
    for (const result of [{ exitCode: 2, signal: null }, { exitCode: null, signal: 'SIGTERM' }]) {
      const f = await fixture(); Object.assign(f.state, result);
      await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow();
    }
  });

  it('rejects unjournaled or stale fingerprints without appending events or accepting restored state', async () => {
    for (const fault of ['unknown', 'stale']) {
      const f = await fixture();
      if (fault === 'unknown') {
        f.snapshot.content.types.articles[0].title = 'Not yet recorded by the CMS writer';
        f.snapshot.fingerprint = contentFingerprint(f.snapshot.content);
        f.snapshot.snapshotId = snapshotId({ fingerprint: f.snapshot.fingerprint, referenceDate: f.snapshot.referenceDate });
      } else await f.ledger.recordEvent({ fingerprint: 'newer-journal-content', marker: 'edit' });
      const before = await f.ledger.entries();
      await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow();
      expect(await f.ledger.entries()).toEqual(before);
    }
  });

  it('rejects a regressed live state until the shared journal has explicitly accepted it', async () => {
    const f = await fixture();
    await f.ledger.recordEvent({ fingerprint: 'newer-state', marker: 'edit' });
    await f.ledger.recordEvent({ fingerprint: f.snapshot.fingerprint!, marker: 'restore' });
    await expect(createPublicationCheckPorts(f.options, f.runtime).capture()).rejects.toThrow();
    expect((await f.ledger.entries()).at(-1)?.marker).toBe('restore');
  });

  it('passes CMS credentials only to capture and strips unrelated credentials even there', async () => {
    const f = await fixture();
    Object.assign(f.options.captureEnv, { GH_TOKEN: CANARY, SSH_AUTH_SOCK: CANARY, RANDOM_PRIVATE_KEY: CANARY });
    const ports = createPublicationCheckPorts(f.options, f.runtime);
    await ports.capture(); await ports.build(f.context);
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0].env.CMS_TOKEN).toBe(CANARY);
    expect(f.commands[0].env.GH_TOKEN).toBeUndefined();
    expect(f.commands[0].env.SSH_AUTH_SOCK).toBeUndefined();
    expect(f.commands[0].env.RANDOM_PRIVATE_KEY).toBeUndefined();
    expect(JSON.stringify(f.commands[1])).not.toContain(CANARY);
    expect(f.commands[0].args.join(' ')).not.toContain(CANARY);
  });

  it('runs the existing npm build once with the captured source and independently selected CRM/payment roles', async () => {
    const f = await fixture(); f.context.deployMode = 'prod'; f.context.env.DEPLOY_MODE = 'prod'; delete f.context.env.DEMO_FORMS;
    await createPublicationCheckPorts(f.options, f.runtime).build(f.context);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({ args: ['run', 'build'], cwd: f.options.webRoot });
    expect(f.commands[0].file).toMatch(/(?:^|\/)npm$/);
    expect(f.commands[0].env).toMatchObject({ CONTENT_SNAPSHOT_DIR: f.options.snapshotDir, DEPLOY_MODE: 'prod', PAYMENT_ROLE: 'ci' });
    expect(existsSync(join(f.context.treeDir, 'index.html'))).toBe(true);
  });

  it('rejects failed build even if the command leaves a populated output directory', async () => {
    const f = await fixture(); f.state.exitCode = 1;
    await expect(createPublicationCheckPorts(f.options, f.runtime).build(f.context)).rejects.toThrow();
  });

  it('refuses a tree other than this worktree web/dist before any command or preview', async () => {
    const f = await fixture(); f.context.treeDir = join(f.temp, 'foreign-dist');
    const ports = createPublicationCheckPorts(f.options, f.runtime);
    await expect(ports.build(f.context)).rejects.toThrow();
    await expect(ports.checkBuild(f.context)).rejects.toThrow();
    await expect(ports.checkBrowser(f.context)).rejects.toThrow();
    expect(f.commands).toHaveLength(0); expect(f.previews).toHaveLength(0);
  });

  it('uses explicit safe environment for build and browser without merging process.env or captureEnv', async () => {
    const f = await fixture();
    Object.assign(f.context.env, { GH_TOKEN: CANARY, CMS_TOKEN: CANARY, SSH_AUTH_SOCK: CANARY, CANARY_UNCLASSIFIED: CANARY });
    const previous = process.env.ADAPTER_ARBITRARY_SECRET; process.env.ADAPTER_ARBITRARY_SECRET = CANARY;
    try {
      const ports = createPublicationCheckPorts(f.options, f.runtime);
      await ports.build(f.context); await ports.checkBrowser(f.context);
      expect(f.commands.length).toBeGreaterThan(0); expect(f.previews).toHaveLength(1);
      for (const command of f.commands) {
        expect(JSON.stringify(command.env)).not.toContain(CANARY);
        expect(command.env.HOME).toBe(f.context.env.HOME);
      }
      expect(JSON.stringify(f.previews[0].env)).not.toContain(CANARY);
    } finally {
      if (previous === undefined) delete process.env.ADAPTER_ARBITRARY_SECRET;
      else process.env.ADAPTER_ARBITRARY_SECRET = previous;
    }
  });
});

describe('publication production adapters: real reporter files and fixed selections', () => {
  it('snapshot group runs fixed contract/media/journal suite and returns executed assertion count', async () => {
    const f = await fixture();
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkSnapshot(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    vitestCommand(f.commands[0], 'snapshot', f.reportPath('snapshot'));
    expect(f.commands[0].env).toMatchObject({ CONTENT_SNAPSHOT_DIR: f.context.snapshotDir, PUBLICATION_LEDGER_DIR: f.options.ledgerDir });
  });

  it('build-content group checks existing exact output without invoking build wrappers again', async () => {
    const f = await fixture();
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkBuild(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    expect(f.commands).toHaveLength(1); vitestCommand(f.commands[0], 'build', f.reportPath('build'));
    expect(f.commands[0].env.PUBLICATION_TREE_DIR).toBe(f.context.treeDir);
    expect(f.commands[0].env.CONTENT_SNAPSHOT_DIR).toBe(f.context.snapshotDir);
  });

  it('destination group fixes modes/forms/analytics/robots/chat selection instead of accepting command or group input', async () => {
    const f = await fixture();
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkDestination(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    vitestCommand(f.commands[0], 'destination', f.reportPath('destination'));
    expect(f.commands[0].env.PUBLICATION_DESTINATION_ID).toBe(f.context.destinationId);
    expect(f.commands[0].env.DEPLOY_MODE).toBe('stand');
    expect(f.commands[0].env.PAYMENT_ROLE).toBe('ci');
  });

  it('exit zero cannot replace a missing malformed or pre-existing stale JSON report', async () => {
    for (const fault of ['missing', 'malformed', 'stale'] as const) {
      const f = await fixture();
      if (fault === 'missing') f.state.omitReport = true;
      if (fault === 'malformed') f.state.rawReport = '{bad JSON';
      if (fault === 'stale') { f.state.omitReport = true; writeFileSync(f.reportPath('build'), JSON.stringify(f.state.reports.build)); }
      await expect(createPublicationCheckPorts(f.options, f.runtime).checkBuild(f.context)).rejects.toThrow();
    }
  });

  it('rejects zero failed skipped todo and non-success Vitest evidence rather than counting collected tests', async () => {
    for (const mutation of ['zero', 'failed', 'skipped', 'todo', 'unsuccessful', 'process'] as const) {
      const f = await fixture(); const report = f.state.reports.build;
      if (mutation === 'zero') { report.numPassedTests = 0; report.numTotalTests = 0; report.testResults = []; }
      if (mutation === 'failed') { report.numFailedTests = 1; report.testResults[0].assertionResults[0].status = 'failed'; }
      if (mutation === 'skipped') { report.numPendingTests = 1; report.testResults[0].assertionResults[0].status = 'pending'; }
      if (mutation === 'todo') { report.numTodoTests = 1; report.testResults[0].assertionResults[0].status = 'todo'; }
      if (mutation === 'unsuccessful') report.success = false;
      if (mutation === 'process') f.state.exitCode = 2;
      await expect(createPublicationCheckPorts(f.options, f.runtime).checkBuild(f.context)).rejects.toThrow();
    }
  });

  it('rejects fabricated aggregate counts without matching completed assertion results', async () => {
    const f = await fixture(); f.state.reports.build.numPassedTests = 900; f.state.reports.build.numTotalTests = 900;
    await expect(createPublicationCheckPorts(f.options, f.runtime).checkBuild(f.context)).rejects.toThrow();
  });

  it('browser checks both projects against its own preview of the same tree and closes it', async () => {
    const f = await fixture();
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkBrowser(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 4 });
    expect(f.previews).toHaveLength(1); expect(f.previews[0].treeDir).toBe(f.context.treeDir);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0].args).toEqual(expect.arrayContaining(['test', 'tests/publication-smoke.spec.ts', '--config', 'playwright.publication.config.ts', '--project=desktop', '--project=mobile', '--reporter=json']));
    expect(f.commands[0].env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(f.reportPath('browser'));
    expect(f.commands[0].env.PUBLICATION_BASE_URL).toBe('http://127.0.0.1:47321');
    expect(f.state.closed).toBe(1);
  });

  it('browser rejects missing mobile zero skipped interrupted and flaky evidence even with aggregate expected counts', async () => {
    for (const mutation of ['mobile', 'zero', 'skip', 'interrupted', 'flaky', 'error'] as const) {
      const f = await fixture(); const report = f.state.browser;
      if (mutation === 'mobile') for (const spec of report.suites[0].specs) spec.tests = spec.tests.filter((test) => test.projectName !== 'mobile');
      if (mutation === 'zero') report.suites = [];
      if (mutation === 'skip') report.suites[0].specs[0].tests[0].results[0].status = 'skipped';
      if (mutation === 'interrupted') report.suites[0].specs[0].tests[0].results[0].status = 'interrupted';
      if (mutation === 'flaky') report.suites[0].specs[0].tests[0].results.unshift({ status: 'failed', retry: 0 });
      if (mutation === 'error') Object.assign(report, { errors: [{ message: 'web server failed' }] });
      await expect(createPublicationCheckPorts(f.options, f.runtime).checkBrowser(f.context)).rejects.toThrow();
      expect(f.state.closed).toBe(1);
    }
  });

  it('browser process failure or missing report cannot return success and always releases preview', async () => {
    for (const fault of ['exit', 'signal', 'report'] as const) {
      const f = await fixture();
      if (fault === 'exit') f.state.exitCode = 1;
      if (fault === 'signal') { f.state.exitCode = null; f.state.signal = 'SIGTERM'; }
      if (fault === 'report') f.state.omitReport = true;
      await expect(createPublicationCheckPorts(f.options, f.runtime).checkBrowser(f.context)).rejects.toThrow();
      expect(f.state.closed).toBe(1);
    }
  });
});

describe('publication production adapters: independently configured payment role', () => {
  it('ci payment group positively checks absence with no readiness configuration or API command', async () => {
    const f = await fixture(); delete f.options.payment;
    f.context.deployMode = 'prod'; f.context.env.DEPLOY_MODE = 'prod';
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkPaymentAbsent(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    expect(f.commands).toHaveLength(1); vitestCommand(f.commands[0], 'payment-absence', f.reportPath('payment-absence'));
    expect(f.commands[0].env.PAYMENT_ROLE).toBe('ci');
    expect(Object.keys(f.commands[0].env).filter((name) => name.startsWith('PUBLICATION_PAYMENT_'))).toEqual([]);
  });

  it('active readiness uses the explicit endpoint mode and shop rather than inferring them from CRM mode', async () => {
    const f = await fixture(); f.context.paymentRole = 'stand'; f.context.env.PAYMENT_ROLE = 'stand';
    f.context.deployMode = 'prod'; f.context.env.DEPLOY_MODE = 'prod';
    f.context.env.PAYMENT_ENDPOINT_STAND = 'https://untrusted.test.invalid/api';
    const ports = createPublicationCheckPorts(f.options, f.runtime);
    await ports.build(f.context);
    expect(f.commands[0]?.env.PAYMENT_ENDPOINT_STAND).toBe(f.options.payment!.endpoint);
    const result = await ports.checkPaymentReadiness(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    vitestCommand(f.commands[1], 'payment-readiness', f.reportPath('payment-readiness'));
    expect(f.commands[1].env).toMatchObject({
      PUBLICATION_PAYMENT_ENDPOINT: f.options.payment!.endpoint,
      PUBLICATION_PAYMENT_READY_RESPONSE_FILE: expect.any(String),
      PUBLICATION_PAYMENT_MODE: 'test', PUBLICATION_PAYMENT_SHOP_ID: 'shop-42',
    });
  });

  it('active preflight uses trusted endpoint/origin and missing payment configuration fails closed', async () => {
    const f = await fixture(); f.context.paymentRole = 'prod'; f.context.env.PAYMENT_ROLE = 'prod'; f.options.payment!.mode = 'prod';
    f.context.env.PUBLICATION_PAYMENT_ENDPOINT = 'https://untrusted.test.invalid';
    const result = await createPublicationCheckPorts(f.options, f.runtime).checkPaymentPreflight(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    vitestCommand(f.commands[0], 'payment-preflight', f.reportPath('payment-preflight'));
    expect(f.commands[0].env.PUBLICATION_PAYMENT_ENDPOINT).toBe(f.options.payment!.endpoint);
    expect(f.commands[0].env.PUBLICATION_PAYMENT_SITE_ORIGIN).toBe(f.options.payment!.siteOrigin);
    const missing = await fixture(); missing.context.paymentRole = 'prod'; delete missing.options.payment;
    await expect(createPublicationCheckPorts(missing.options, missing.runtime).checkPaymentReadiness(missing.context)).rejects.toThrow();
    await expect(createPublicationCheckPorts(missing.options, missing.runtime).checkPaymentPreflight(missing.context)).rejects.toThrow();
    expect(missing.commands).toHaveLength(0);
  });
});
