import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODULES,
  loadModule,
  type LedgerModule,
  type PublishGateModule,
} from './helpers/cms-content-publication-contract';

// Спека `deploy-gating` этого change: требования «Публикация только после успешного прогона
// тестов», «Публикуется только проверенное содержимое», «Ручная публикация остаётся
// доступной», «Устаревший результат не откатывает сайт», «Более старое состояние контента не
// публикуется поверх более нового».
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: гейта по ревизии и отметке ещё нет (tasks.md 7.1–7.4).
//
// Разделение «устаревание против регресса» проверяется в ОБЕ стороны: недостижимость любой из
// двух ветвей — это ровно тот дефект, который дважды проходил ревью (design.md, D4).

const gateModule = (): Promise<PublishGateModule> => loadModule<PublishGateModule>(MODULES.publishGate);
const ledgerModule = (): Promise<LedgerModule> => loadModule<LedgerModule>(MODULES.ledger);

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

describe('гейт публикации: устаревание против регресса', () => {
  // Сценарий: устаревший снимок отменяется без участия человека
  it('есть запись новее НАБЛЮДЁННОЙ — выкладка отменяется, подтверждения не требуется', async () => {
    const mod = await gateModule();
    const decision = mod.classifySnapshotForPublication({
      observedEntry: 7,
      latestEntry: 9,
      revision: 7,
      highWaterMark: 9,
    });

    expect(decision.action).toBe('cancel-stale');
    expect(decision.recorded, 'отмена обязана быть записана').toBe(true);
    expect(decision.runScheduledForLatestEntry, 'устаревание не запускает новую публикацию автоматически').toBe(false);
  });

  // Негативная проверка ветви устаревания (tasks.md 7.2): человек не должен появляться вовсе.
  it('пять правок быстрее одного прогона не требуют ни одного подтверждения', async () => {
    const mod = await gateModule();
    const decisions = [1, 2, 3, 4, 5].map((i) =>
      mod.classifySnapshotForPublication({
        observedEntry: i,
        latestEntry: 5,
        revision: i,
        highWaterMark: 5,
      }),
    );

    const confirmations = decisions.filter((d) => d.action === 'require-confirmation');
    expect(confirmations, 'редактор попал в цикл подтверждений при исправной системе').toEqual([]);
    expect(decisions.slice(0, 4).map((d) => d.action)).toEqual([
      'cancel-stale',
      'cancel-stale',
      'cancel-stale',
      'cancel-stale',
    ]);
    expect(decisions[4].action, 'последнее состояние публикуется').toBe('publish');
  });

  // Сценарий: восстановление базы не считается устареванием
  it('наблюдённая запись последняя, а ревизия ниже отметки — регресс, а не устаревание', async () => {
    const mod = await gateModule();
    const decision = mod.classifySnapshotForPublication({
      observedEntry: 12,
      latestEntry: 12,
      revision: 3,
      highWaterMark: 11,
    });

    expect(decision.action).toBe('require-confirmation');
    expect(decision.action, 'регресс уехал в ветвь устаревания и отменился молча').not.toBe('cancel-stale');
  });

  // Сценарий: база восстановлена из резервной копии
  it('обычный прогон на восстановленной базе не публикует до подтверждения', async () => {
    const mod = await gateModule();
    const decision = mod.classifySnapshotForPublication({
      observedEntry: 4,
      latestEntry: 4,
      revision: 1,
      highWaterMark: 3,
    });
    expect(decision.action).toBe('require-confirmation');
  });

  // Сценарий: явное подтверждение разрешает публикацию
  it('подтверждение участником с правом записи разрешает публикацию и фиксируется', async () => {
    const mod = await gateModule();
    const decision = mod.classifySnapshotForPublication({
      observedEntry: 4,
      latestEntry: 4,
      revision: 1,
      highWaterMark: 3,
      confirmedBy: 'pgorbachev',
    });

    expect(decision.action).toBe('publish');
    expect(decision.recorded, 'подтверждение зафиксировано вместе с ревизией и отметкой').toBe(true);
  });

  it('ревизия не ниже отметки при последней наблюдённой записи — обычная публикация', async () => {
    const mod = await gateModule();
    expect(
      mod.classifySnapshotForPublication({
        observedEntry: 9,
        latestEntry: 9,
        revision: 9,
        highWaterMark: 9,
      }).action,
    ).toBe('publish');
  });

  it('неопределённая ревизия останавливает публикацию до подтверждения', async () => {
    const mod = await gateModule();
    const decision = mod.classifySnapshotForPublication({
      observedEntry: 4,
      latestEntry: 4,
      revision: null,
      highWaterMark: 3,
    });
    expect(decision.action).toBe('require-confirmation');
  });
});

describe('гейт публикации: принятие состояния и повторный откат', () => {
  // Сценарий: после принятого отката обычные прогоны не требуют подтверждения
  it('принятие состояния поднимает ревизию восстановленного содержимого до уровня отметки', async () => {
    const ledgerMod = await ledgerModule();
    const gate = await gateModule();
    const ledger = ledgerMod.createLedger({
      dir: mkdtempSync(join(tmpdir(), 'ikpk-accept-')),
      hasPublicationHistory: true,
    });

    await ledger.recordEvent({ fingerprint: 'A', marker: 'initial-migration' });
    await ledger.recordEvent({ fingerprint: 'B', marker: 'edit' });
    await ledger.recordEvent({ fingerprint: 'A', marker: 'restore' });

    const beforeAccept = await ledger.observe({ fingerprint: 'A' });
    expect(
      gate.classifySnapshotForPublication({
        observedEntry: beforeAccept.observedEntry,
        latestEntry: beforeAccept.observedEntry,
        revision: beforeAccept.revision,
        highWaterMark: beforeAccept.highWaterMark,
      }).action,
    ).toBe('require-confirmation');

    await ledger.acceptState({ fingerprint: 'A', confirmedBy: 'pgorbachev' });

    const afterAccept = await ledger.observe({ fingerprint: 'A' });
    expect(afterAccept.revision).toBe(afterAccept.highWaterMark);
    expect(
      gate.classifySnapshotForPublication({
        observedEntry: afterAccept.observedEntry,
        latestEntry: afterAccept.observedEntry,
        revision: afterAccept.revision,
        highWaterMark: afterAccept.highWaterMark,
      }).action,
      'после принятия календарный прогон снова просит человека — подтверждение стало вечным',
    ).toBe('publish');
  });

  // Сценарий: второй откат подряд снова требует подтверждения
  it('откат после принятого отката снова останавливается до подтверждения', async () => {
    const ledgerMod = await ledgerModule();
    const gate = await gateModule();
    const ledger = ledgerMod.createLedger({
      dir: mkdtempSync(join(tmpdir(), 'ikpk-accept2-')),
      hasPublicationHistory: true,
    });

    await ledger.recordEvent({ fingerprint: 'OLDEST', marker: 'initial-migration' });
    await ledger.recordEvent({ fingerprint: 'MIDDLE', marker: 'edit' });
    await ledger.recordEvent({ fingerprint: 'NEWEST', marker: 'edit' });
    await ledger.recordEvent({ fingerprint: 'MIDDLE', marker: 'restore' });
    await ledger.acceptState({ fingerprint: 'MIDDLE', confirmedBy: 'pgorbachev' });

    await ledger.recordEvent({ fingerprint: 'OLDEST', marker: 'restore' });
    const observed = await ledger.observe({ fingerprint: 'OLDEST' });

    expect(
      gate.classifySnapshotForPublication({
        observedEntry: observed.observedEntry,
        latestEntry: observed.observedEntry,
        revision: observed.revision,
        highWaterMark: observed.highWaterMark,
      }).action,
    ).toBe('require-confirmation');
  });
});

describe('событийная публикация запрещена', () => {
  // Сценарии: тесты прошли и коммит остаётся вершиной; проверенный коммит остаётся вершиной
  it('успешный прогон при несдвинувшейся вершине не публикует без явной команды', async () => {
    const mod = await gateModule();
    expect(
      mod.classifyEventDrivenPublication({
        verifiedCommit: COMMIT_A,
        headAtLastCheck: COMMIT_A,
        testRunConclusion: 'success',
      }).action,
    ).not.toBe('publish');
  });

  // Сценарии: тесты упали; прогон отменён
  it.each([['failure'], ['cancelled'], ['skipped'], ['missing']] as const)(
    'прогон с исходом %s не публикует',
    async (conclusion) => {
      const mod = await gateModule();
      const decision = mod.classifyEventDrivenPublication({
        verifiedCommit: COMMIT_A,
        headAtLastCheck: COMMIT_A,
        testRunConclusion: conclusion,
      });
      expect(decision.action).not.toBe('publish');
    },
  );

  // Сценарии: тесты прошли, но коммит уже перекрыт; во время прогона в ветку приехал новый
  // коммит; вершина сдвинулась, пока шла сборка; перезапуск старого прогона;
  // событийный путь исключением не пользуется
  it('перекрытый коммит не публикуется событийным путём ни при каких условиях', async () => {
    const mod = await gateModule();
    const decision = mod.classifyEventDrivenPublication({
      verifiedCommit: COMMIT_A,
      headAtLastCheck: COMMIT_B,
      testRunConclusion: 'success',
    });

    expect(decision.action).not.toBe('publish');
  });
});

// The retired cached-pair selector and snapshot-age rollback contract are replaced by
// tests/manual-publication-core.test.ts: fresh local pair, retained release and evidence.
// Ledger/regression scenarios above remain applicable to the local publication path.
