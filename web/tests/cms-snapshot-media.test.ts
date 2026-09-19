import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseManualPublication, PUBLICATION_CI_POLICY, PUBLICATION_GROUPS, ROLLBACK_GROUPS, SNAPSHOT_RETENTION_DAYS, type PublicationRecord } from '../scripts/lib/publish-gate.ts';
import {
  MODULES,
  loadModule,
  type MediaStoreModule,
} from './helpers/cms-content-publication-contract';

// Спека `cms-content-source`, требование «Снимок воспроизводит медиа, а не ссылается на
// изменяемое хранилище».
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: контент-адресуемого хранилища медиа ещё нет (tasks.md 3.7).

const storeModule = (): Promise<MediaStoreModule> => loadModule<MediaStoreModule>(MODULES.mediaStore);

function storeWith(entries: Record<string, string>): { dir: string; ids: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-media-'));
  const ids: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    writeFileSync(join(dir, name), bytes);
    ids[name] = name;
  }
  return { dir, ids };
}

describe('медиа снимка: содержимое, а не ссылка на изменяемое хранилище', () => {
  // Сценарий: сборка из снимка без доступа к системе управления (часть про медиа)
  it('файл читается из хранилища по идентификатору содержимого, без обращения к системе управления', async () => {
    const mod = await storeModule();
    const bytes = 'содержимое картинки';
    const contentId = mod.contentIdOf(bytes);
    const { dir } = storeWith({ [contentId]: bytes });

    const read = mod.readFromStore({ storeDir: dir, contentId });
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes).toString('utf-8')).toBe(bytes);
  });

  // Сценарий: файл заменён после снятия снимка
  it('замена файла в системе управления прежний снимок не трогает', async () => {
    const mod = await storeModule();
    const original = 'первая версия';
    const replaced = 'вторая версия';
    const originalId = mod.contentIdOf(original);
    const replacedId = mod.contentIdOf(replaced);

    // Идентификатор вычисляется из содержимого, поэтому новая версия — другой предмет,
    // а не подмена прежнего.
    expect(replacedId).not.toBe(originalId);

    const { dir } = storeWith({ [originalId]: original, [replacedId]: replaced });
    const read = mod.readFromStore({ storeDir: dir, contentId: originalId });
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes).toString('utf-8')).toBe(original);
  });

  // Сценарий: содержимое хранилища не совпадает с идентификатором
  it('подмена содержимого под тем же идентификатором — неуспех с указанием файла', async () => {
    const mod = await storeModule();
    const contentId = mod.contentIdOf('подлинное содержимое');
    const { dir } = storeWith({ [contentId]: 'подменённое содержимое' });

    const read = mod.readFromStore({ storeDir: dir, contentId });
    expect(read.ok, 'подмена попала бы в вывод').toBe(false);
    if (!read.ok) {
      expect(read.reason).toBe('content-id-mismatch');
      expect(read.contentId).toBe(contentId);
    }
  });

  it('отсутствующий файл отличается от подменённого', async () => {
    const mod = await storeModule();
    const { dir } = storeWith({});
    const read = mod.readFromStore({ storeDir: dir, contentId: mod.contentIdOf('нет такого') });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('missing');
  });

  // The publication contract now requires an actual retained release and immutable
  // verification evidence; snapshot age alone cannot authorize a rollback.
  it('сохранённые медиа воспроизводятся, а откат требует проверенного сохранённого релиза', async () => {
    const store = await storeModule();
    expect(SNAPSHOT_RETENTION_DAYS).toBeGreaterThan(0);
    const bytes = 'медиа проверенной пары';
    const contentId = store.contentIdOf(bytes);
    const { dir } = storeWith({ [contentId]: bytes });
    const identity = { commit: 'a'.repeat(40), snapshotId: 'snapshot-retained', destinationId: 'stand', treeDigest: '1'.repeat(64) };
    const groups = (names: readonly string[]) => names.map((name) => ({ name, conclusion: 'success' as const, executedTests: 1 }));
    const publication: PublicationRecord = {
      ...identity, publicationId: 'publication-original', releaseId: 'retained-release',
      revision: 2, referenceDate: '2026-08-20', capturedAt: '2026-08-20T00:00:00Z',
      testRunConclusion: 'success', publishedAt: '2026-08-20T01:00:00Z', actor: 'operator',
      paymentRole: 'ci', deployMode: 'stand',
      ciEvidence: { repository: PUBLICATION_CI_POLICY.repository, workflow: PUBLICATION_CI_POLICY.workflow,
        branch: 'main', event: 'push', commit: identity.commit, runId: 123, conclusion: 'success', executedTests: 10,
        jobs: PUBLICATION_CI_POLICY.requiredJobs.map((name) => ({ name, conclusion: 'success' })) },
      localChecks: { ...identity, groups: groups(PUBLICATION_GROUPS) },
    };
    const input = {
      headCommit: 'b'.repeat(40), headAtLastCheck: 'b'.repeat(40), highWaterMark: 9,
      now: '2026-08-24T12:00:00Z', retentionDays: SNAPSHOT_RETENTION_DAYS, actor: 'operator',
      verifiedPairs: [publication], destinationId: identity.destinationId, treeDigest: identity.treeDigest,
      localChecks: { ...identity, groups: groups(ROLLBACK_GROUPS) },
      retainedReleases: [{ releaseId: publication.releaseId, destinationId: identity.destinationId, treeDigest: identity.treeDigest }],
      rollback: { snapshotId: identity.snapshotId, releaseId: publication.releaseId, confirmed: true, reason: 'confirmed rollback' },
    };
    expect(chooseManualPublication(input).action).toBe('publish');
    expect(chooseManualPublication({ ...input, retainedReleases: [] }).action).toBe('refuse');
    const read = store.readFromStore({ storeDir: dir, contentId });
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.bytes).toString('utf8')).toBe(bytes);
  });
});
