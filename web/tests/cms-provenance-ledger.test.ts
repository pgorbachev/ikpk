import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODULES,
  loadModule,
  type LedgerModule,
  type ProvenanceLedger,
} from './helpers/cms-content-publication-contract';

// Спека `cms-content-source`, требование «Возраст состояния контента определяется журналом
// происхождения». Таблица «Ревизия контента снимка определяется так» — предмет большей части
// этого файла.
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: журнала происхождения ещё нет (tasks.md 4.1–4.9).
//
// ВАЖНО про то, что здесь проверяется, а что нет. Журнал — единственное место, где различаются
// «содержимое стало новее» и «содержимое вернулось назад», поэтому проверяются ОБЕ ветви и
// недостижимость ни одной из них: две прежние редакции требования делали ветвь регресса
// недостижимой, и гейт от регресса при этом оставался формально включённым (design.md, D4).

const ledgerModule = (): Promise<LedgerModule> => loadModule<LedgerModule>(MODULES.ledger);

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'ikpk-ledger-'));
}

async function ledgerWith(
  events: { fingerprint: string; marker: 'edit' | 'restore' | 'initial-migration' | null }[],
  options: { hasPublicationHistory?: boolean } = {},
): Promise<{ ledger: ProvenanceLedger; dir: string }> {
  const mod = await ledgerModule();
  const dir = freshDir();
  const ledger = mod.createLedger({ dir, hasPublicationHistory: options.hasPublicationHistory ?? true });
  for (const event of events) await ledger.recordEvent(event);
  return { ledger, dir };
}

describe('журнал происхождения: номера и маркеры', () => {
  // Задача 4.9: стартовые значения.
  it('до первой записи отметка равна нулю, а первая запись — «первичный перенос»', async () => {
    const mod = await ledgerModule();
    const ledger = mod.createLedger({ dir: freshDir(), hasPublicationHistory: false });

    expect(await ledger.highWaterMark()).toBe(0);
    expect(await ledger.entries()).toHaveLength(0);

    const first = await ledger.recordEvent({ fingerprint: 'A', marker: 'initial-migration' });
    expect(first.number).toBe(1);
    expect(first.previous).toBeNull();
    expect(first.marker).toBe('initial-migration');
    expect(await ledger.highWaterMark()).toBe(1);
  });

  // Сценарий: правка контента выдаёт следующий номер
  it('правка с ранее не встречавшимся отпечатком получает следующий номер и поднимает отметку', async () => {
    const { ledger } = await ledgerWith([{ fingerprint: 'A', marker: 'initial-migration' }]);

    const entry = await ledger.recordEvent({ fingerprint: 'B', marker: 'edit' });
    expect(entry.number).toBe(2);
    expect(entry.previous).toBe(1);

    const observed = await ledger.observe({ fingerprint: 'B' });
    expect(observed.revision).toBe(2);
    expect(observed.observedEntry).toBe(2);
    expect(observed.highWaterMark).toBe(2);
    expect(observed.requiresConfirmation).toBe(false);
  });

  // Сценарий: пересборка без изменений не создаёт записи
  it('два снятия снимка без правок не создают записи и не двигают отметку', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' },
      { fingerprint: 'B', marker: 'edit' },
    ]);

    const first = await ledger.observe({ fingerprint: 'B' });
    const second = await ledger.observe({ fingerprint: 'B' });

    expect(await ledger.entries()).toHaveLength(2);
    expect(second.highWaterMark).toBe(first.highWaterMark);
    expect(second.revision).toBe(first.revision);
  });

  // Сценарий: два снимка одного состояния ссылаются на одну ревизию
  it('два прогона на одном состоянии дают одну ревизию и один номер наблюдённой записи', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' },
      { fingerprint: 'B', marker: 'edit' },
    ]);

    const [left, right] = await Promise.all([
      ledger.observe({ fingerprint: 'B' }),
      ledger.observe({ fingerprint: 'B' }),
    ]);

    expect(left.revision).toBe(right.revision);
    expect(left.observedEntry).toBe(right.observedEntry);
    expect(await ledger.entries()).toHaveLength(2);
  });
});

describe('журнал происхождения: восстановление, возврат и неизвестное состояние', () => {
  // Сценарий: база восстановлена из резервной копии
  it('восстановление на известный отпечаток даёт ревизию ПЕРВОЙ записи с ним, ниже отметки', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' }, // запись 1
      { fingerprint: 'B', marker: 'edit' }, // запись 2
      { fingerprint: 'C', marker: 'edit' }, // запись 3
      { fingerprint: 'A', marker: 'restore' }, // запись 4: вернулись к состоянию записи 1
    ]);

    const observed = await ledger.observe({ fingerprint: 'A' });

    expect(await ledger.entries()).toHaveLength(4);
    expect(observed.observedEntry).toBe(4);
    expect(observed.highWaterMark).toBe(4);
    // Здесь и ломались обе прежние редакции: ревизия обязана быть НИЖЕ отметки, иначе гейт
    // от регресса недостижим.
    expect(observed.revision).toBe(1);
    expect(observed.revision as number).toBeLessThan(observed.highWaterMark);
  });

  // Сценарий: редактор вручную вернул прежний текст
  it('ручной возврат текста — движение вперёд: ревизия равна номеру новой записи', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' },
      { fingerprint: 'B', marker: 'edit' },
      { fingerprint: 'A', marker: 'edit' }, // редактор напечатал прежний текст руками
    ]);

    const observed = await ledger.observe({ fingerprint: 'A' });
    expect(observed.revision).toBe(3);
    expect(observed.revision).toBe(observed.highWaterMark);
    expect(observed.requiresConfirmation).toBe(false);
  });

  // Сценарий: совпадение отпечатка без маркера события
  it('совпадение отпечатка без маркера — ревизия не определяется, нужно подтверждение', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' },
      { fingerprint: 'B', marker: 'edit' },
      { fingerprint: 'A', marker: null }, // процедура восстановления забыла маркер
    ]);

    const observed = await ledger.observe({ fingerprint: 'A' });
    expect(observed.revision).toBeNull();
    expect(observed.requiresConfirmation).toBe(true);
    expect(observed.reason).toBe('fingerprint-match-without-marker');
  });

  // Сценарий: восстановление с неизвестным отпечатком не публикуется молча
  it('восстановление с неизвестным журналу отпечатком не получает ревизии и требует человека', async () => {
    const { ledger } = await ledgerWith([
      { fingerprint: 'B', marker: 'initial-migration' },
      { fingerprint: 'C', marker: 'edit' },
      { fingerprint: 'A-до-журнала', marker: 'restore' },
    ]);

    const observed = await ledger.observe({ fingerprint: 'A-до-журнала' });
    expect(observed.revision).toBeNull();
    expect(observed.requiresConfirmation).toBe(true);
    expect(observed.reason).toBe('restore-with-unknown-fingerprint');
  });

  // Сценарий: журнал недоступен при непустой истории публикаций
  it('пустой журнал при непустой истории публикаций — не «всё новое», а требование подтверждения', async () => {
    const mod = await ledgerModule();
    const ledger = mod.createLedger({ dir: freshDir(), hasPublicationHistory: true });

    const observed = await ledger.observe({ fingerprint: 'A' });
    expect(observed.revision).toBeNull();
    expect(observed.requiresConfirmation).toBe(true);
    expect(observed.reason).toBe('ledger-unavailable');
  });
});

describe('журнал происхождения: неизменяемость и атомарность', () => {
  // Сценарий: два одновременных изменения контента получают разные номера
  it('одновременные изменения не делят номер и не теряются', async () => {
    const { ledger } = await ledgerWith([{ fingerprint: 'A', marker: 'initial-migration' }]);

    const written = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ledger.recordEvent({ fingerprint: `F-${i}`, marker: 'edit' }),
      ),
    );

    const numbers = written.map((e) => e.number);
    expect(new Set(numbers).size, `номера повторились: ${numbers.join(', ')}`).toBe(8);
    expect(await ledger.entries()).toHaveLength(9);
    expect(await ledger.highWaterMark()).toBe(9);
  });

  // Сценарий: два быстрых изменения дают два разных отпечатка
  it('запись хранит отпечаток СВОЕГО события, а не последнего состояния', async () => {
    const { ledger } = await ledgerWith([{ fingerprint: 'A', marker: 'initial-migration' }]);

    // Два сохранения быстрее, чем обрабатывается событие первого: наивный обработчик,
    // читающий базу позже, записал бы обоим отпечаток B.
    const [first, second] = await Promise.all([
      ledger.recordEvent({ fingerprint: 'A2', marker: 'edit' }),
      ledger.recordEvent({ fingerprint: 'B2', marker: 'edit' }),
    ]);

    expect(first.fingerprint).not.toBe(second.fingerprint);
    const stored = (await ledger.entries()).map((e) => e.fingerprint).sort();
    expect(stored).toEqual(['A', 'A2', 'B2']);
  });

  // Сценарий: журнал не переписывается
  it('правка хранилища журнала отклоняется, а отметка не уменьшается', async () => {
    const { ledger, dir } = await ledgerWith([
      { fingerprint: 'A', marker: 'initial-migration' },
      { fingerprint: 'B', marker: 'edit' },
      { fingerprint: 'C', marker: 'edit' },
    ]);
    expect(await ledger.highWaterMark()).toBe(3);

    // Переписываем хранилище руками: убираем последнюю запись и переиспользуем её номер.
    const files = readdirSync(dir);
    expect(files.length, 'журнал не оставил файлов — проверять нечего').toBeGreaterThan(0);
    for (const file of files) {
      const full = join(dir, file);
      const before = readFileSync(full, 'utf-8');
      if (!before.includes('C')) continue;
      writeFileSync(full, before.replace(/C/g, 'D'));
    }

    await expect(
      ledger.entries(),
      'подмена содержимого журнала прошла молча',
    ).rejects.toThrow();
    // Отметка ведётся отдельно и монотонно: испорченный журнал её не опускает.
    expect(await ledger.highWaterMark()).toBeGreaterThanOrEqual(3);
  });
});
