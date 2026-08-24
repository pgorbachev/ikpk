import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODULES,
  loadModule,
  type MediaStoreModule,
  type PublishGateModule,
} from './helpers/cms-content-publication-contract';

// Спека `cms-content-source`, требование «Снимок воспроизводит медиа, а не ссылается на
// изменяемое хранилище».
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: контент-адресуемого хранилища медиа ещё нет (tasks.md 3.7).

const storeModule = (): Promise<MediaStoreModule> => loadModule<MediaStoreModule>(MODULES.mediaStore);
const gateModule = (): Promise<PublishGateModule> => loadModule<PublishGateModule>(MODULES.publishGate);

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

  // Сценарий: повторная выкладка внутри обещанного срока
  it('срок хранения назван числом, и внутри него повторная выкладка выполняется', async () => {
    const store = await storeModule();
    const gate = await gateModule();
    expect(gate.SNAPSHOT_RETENTION_DAYS).toBeGreaterThan(0);

    const bytes = 'медиа проверенной пары';
    const contentId = store.contentIdOf(bytes);
    const { dir } = storeWith({ [contentId]: bytes });

    const now = Date.parse('2026-08-24T12:00:00Z');
    const withinRetention = new Date(now - (gate.SNAPSHOT_RETENTION_DAYS - 1) * 86_400_000).toISOString();

    const decision = gate.chooseManualPublication({
      headCommit: 'b'.repeat(40),
      headAtLastCheck: 'b'.repeat(40),
      verifiedPairs: [
        {
          commit: 'a'.repeat(40),
          snapshotId: 'snap-внутри-срока',
          revision: 2,
          referenceDate: '2026-08-20',
          capturedAt: withinRetention,
          testRunConclusion: 'success',
        },
      ],
      highWaterMark: 9,
      now: new Date(now).toISOString(),
      retentionDays: gate.SNAPSHOT_RETENTION_DAYS,
      actor: 'pgorbachev',
      rollback: { snapshotId: 'snap-внутри-срока', confirmed: true, reasonHeadNotPublished: 'откат' },
    });

    expect(decision.action).toBe('publish');
    expect(store.readFromStore({ storeDir: dir, contentId }).ok).toBe(true);
  });
});
