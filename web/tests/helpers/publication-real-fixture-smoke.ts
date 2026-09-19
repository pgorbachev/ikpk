/** Manual acceptance harness: loopback CMS fixture, real capture/build/runners/preview.
 * It never contacts a real CMS/payment/SSH service and does not publish.
 * Run from web: npx tsx tests/helpers/publication-real-fixture-smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicationCheckPorts } from '../../scripts/lib/publication-check-adapters';
import { runPublicationChecks } from '../../scripts/lib/publication-checks';
import { FIELD_MAP, SOURCE_TYPES } from '../../scripts/lib/content-field-map';
import { createLedger } from '../../scripts/lib/provenance-ledger';
import type { Snapshot } from '../../scripts/lib/content-snapshot';
import { startCmsStub } from './cms-live-snapshot-capture-contract';

const webRoot = resolve(import.meta.dirname, '../..');
const repoRoot = resolve(webRoot, '..');
const temp = mkdtempSync(join(tmpdir(), 'ikpk-publication-real-fixture-'));
console.log(`fixture evidence directory: ${temp}`);
const fixture = JSON.parse(readFileSync(join(repoRoot, 'fixtures/content-snapshot/snapshot.json'), 'utf8')) as Snapshot;
// Legacy collapsible panels are copied by the capture script alongside CMS data.
// Normalize only fixture input, including those panels; real CMS/artifact validation
// remains strict and the original historical fixture is a documented failing control.
function repairFixtureLinks(value: string): string {
  return value
    .replace(/https:\/\/ikpk\.su\/educational-organization\?section=[23]/g, '/svedeniya-ob-obrazovatelnoy-organizatsii')
    .replace(/https:\/\/ikpk\.su\/institute-(?:clinical-kinesiology|upledgera)\/programs-form\/(?:152|158)\?seminarId=\d+/g, '/raspisanie-i-tseny');
}
function set(record: Record<string, unknown>, source: string, value: unknown) {
  const parts = source.split('.'); let object = record;
  for (const part of parts.slice(0, -1)) {
    object[part] ??= {};
    object = object[part] as Record<string, unknown>;
  }
  object[parts.at(-1)!] = value;
}
const dataset = Object.fromEntries(SOURCE_TYPES.map((type) => [type.endpoint, { records: fixture.content.types[type.type].map((record, index) => {
  const raw: Record<string, unknown> = { id: index + 1 };
  for (const entry of FIELD_MAP.filter((entry) => entry.type === type.type)) {
    if (['htmlToText', 'legacyUrlFromId', 'mediaUrlList'].includes(entry.transform ?? '')) continue;
    let value = ['mediaRef', 'mediaUrl'].includes(entry.transform ?? '') ? { id: 1, url: '/uploads/fixture.png' } : record[entry.field];
    if (typeof value === 'string') value = repairFixtureLinks(value);
    if (value !== undefined) set(raw, entry.source, value);
  }
  return raw;
}) }]));
const cms = await startCmsStub(dataset, { '/uploads/fixture.png': { bytes: readFileSync(join(repoRoot, 'media-originals/legacy/logo-v2.png')) } });
try {
  const snapshotDir = join(temp, 'snapshot'); const ledgerDir = join(temp, 'journal');
  const options = { webRoot, snapshotDir, ledgerDir, reportsDir: join(temp, 'reports'),
    captureEnv: { PATH: process.env.PATH, CMS_URL: cms.url, CMS_TOKEN: 'local-fixture-only-canary' } };
  const ports = createPublicationCheckPorts(options);
  // Fixture preparation deliberately proves an unknown journal fails closed. Its captured
  // content is then explicitly recorded by this fixture's simulated CMS journal writer.
  await assert.rejects(ports.capture(), /latest journal/);
  const captured = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as Snapshot;
  await createLedger({ dir: ledgerDir }).recordEvent({ fingerprint: captured.fingerprint!, marker: 'initial-migration' });
  let captures = 0; let builds = 0;
  const checks = await runPublicationChecks({ commit: 'a'.repeat(40), destinationId: 'fixture-stand', deployMode: 'stand', paymentRole: 'ci',
    treeDir: join(webRoot, 'dist'), reportPath: join(temp, 'publication.json'),
    env: { PATH: process.env.PATH, DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'none' },
  }, { ...ports,
    async capture() {
      captures++;
      const result = await ports.capture();
      const panels = join(snapshotDir, 'collapsible_panels.json');
      writeFileSync(panels, repairFixtureLinks(readFileSync(panels, 'utf8')));
      return result;
    },
    async build(context) { builds++; return ports.build(context); },
  });
  assert.equal(captures, 1); assert.equal(builds, 1);
  const evidence = { fixtureOnly: true, setupCaptureCount: 1, publicationCaptures: captures, publicationBuilds: builds,
    cmsRequests: cms.requests.length, mediaRequests: cms.uploadRequests.length, checks };
  writeFileSync(join(temp, 'smoke-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally { await cms.close(); }
