#!/usr/bin/env node
/** Check-only entry: fixed groups over one supplied live snapshot, with no publication effects. */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedFile, readConfig } from './publication-context.ts';
import { canonicalPath, inside, runPublicationChecks } from './lib/publication-checks.ts';
import { readPublicationSnapshot } from './lib/publication-snapshot.ts';
import { createPublicationCheckPorts } from './lib/publication-check-adapters.ts';
import { createSshTransport } from '../../scripts/publication-transport.mjs';

interface CommandInput { argv: string[]; env: Record<string, string | undefined>; cwd: string }
function argumentsFor(argv: string[]) {
  const keys = ['--snapshot-dir', '--ledger-dir', '--config', '--commit', '--report'];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!keys.includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('publication-check-arguments');
    values.set(key, value);
  }
  if (values.size !== keys.length || !/^[a-f0-9]{40}$/.test(values.get('--commit')!)) throw new Error('publication-check-arguments');
  for (const key of keys.filter((key) => key !== '--commit')) {
    if (!isAbsolute(values.get(key)!)) throw new Error('publication-check-arguments');
  }
  return { commit: values.get('--commit')!, snapshotDir: values.get('--snapshot-dir')!,
    ledgerDir: values.get('--ledger-dir')!, configPath: values.get('--config')!, reportPath: values.get('--report')! };
}

export async function runPublicationCheckCommand({ argv, cwd }: CommandInput) {
  const input = argumentsFor(argv);
  const config = readConfig(protectedFile(input.configPath));
  const webRoot = realpathSync(cwd);
  const treeDir = join(webRoot, 'dist');
  const snapshotDir = realpathSync(input.snapshotDir), ledgerDir = realpathSync(input.ledgerDir);
  const reportPath = canonicalPath(input.reportPath), reportsDir = reportPath + '.checks';
  if ([treeDir, snapshotDir, ledgerDir].some((root) => inside(canonicalPath(root), reportPath) || inside(canonicalPath(root), reportsDir)) ||
      existsSync(reportPath) || existsSync(reportsDir)) throw new Error('publication-check-report-path');
  const snapshot = readPublicationSnapshot(snapshotDir);
  const [user, host] = config.sshTarget.split('@');
  async function paymentReadiness() {
    if (config.paymentRole === 'ci') throw new Error('ci must not contact payment API');
    let usable = true;
    try {
      const transport = createSshTransport({ host, user, root: config.webRoot, destinationId: config.destinationId,
        knownHostsFile: config.knownHostsFile, keepReleases: config.keepReleases,
        async authorize(request: { action: string; destinationId: string }) {
          if (!usable || request.destinationId !== config.destinationId || !['connect', 'payment-readiness'].includes(request.action)) {
            throw new Error('readiness action not authorized');
          }
          return { commit: input.commit, destinationId: config.destinationId };
        } });
      return await transport.withLock((session: { paymentReadiness(): Promise<{ status: number; contentType: string; body: unknown }> }) => session.paymentReadiness());
    } finally { usable = false; }
  }
  const ports = createPublicationCheckPorts({ webRoot, snapshotDir, ledgerDir, reportsDir, captureEnv: {},
    ...(config.paymentRole !== 'ci' ? { payment: config.payment } : {}) }, { paymentReadiness });
  // The caller already captured this snapshot; checks must not silently recapture it.
  ports.capture = async () => ({ snapshotDir, snapshotId: snapshot.snapshotId! });
  return runPublicationChecks({ commit: input.commit, destinationId: config.destinationId,
    deployMode: config.deployMode, paymentRole: config.paymentRole, treeDir, reportPath,
    env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', CHAT_LOADER_SRC: config.chatLoaderSrc,
      ...(config.deployMode === 'stand' ? { DEMO_FORMS: config.demoForms ?? 'stub' } : {}) },
  }, ports);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const report = await runPublicationCheckCommand({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) {
    process.stderr.write(error instanceof Error && error.message === 'publication-check-arguments'
      ? 'publication-check-arguments\n' : 'publication-checks-failed\n');
    process.exitCode = 1;
  }
}
