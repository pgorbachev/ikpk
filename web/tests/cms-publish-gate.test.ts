import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODULES,
  loadModule,
  type LedgerModule,
  type PublishGateModule,
  type VerifiedPair,
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

const pair = (over: Partial<VerifiedPair> = {}): VerifiedPair => ({
  commit: COMMIT_A,
  snapshotId: 'snap-1',
  revision: 5,
  referenceDate: '2026-08-24',
  capturedAt: '2026-08-24T03:00:00Z',
  testRunConclusion: 'success',
  ...over,
});

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
    expect(decision.runScheduledForLatestEntry, 'для последней записи гарантирован прогон').toBe(true);
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

describe('событийная публикация: проверенная пара и актуальность вершины', () => {
  // Сценарии: тесты прошли и коммит остаётся вершиной; проверенный коммит остаётся вершиной
  it('успешный прогон при несдвинувшейся вершине публикует проверенную пару', async () => {
    const mod = await gateModule();
    expect(
      mod.classifyEventDrivenPublication({
        verifiedCommit: COMMIT_A,
        headAtLastCheck: COMMIT_A,
        testRunConclusion: 'success',
      }).action,
    ).toBe('publish');
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
    expect(decision.reason).toBe('head-moved');
  });
});

describe('ручная публикация: новейшая проверенная пара, отказы и подтверждённый откат', () => {
  const manual = async (
    input: Partial<Parameters<PublishGateModule['chooseManualPublication']>[0]> = {},
  ) => {
    const mod = await gateModule();
    return mod.chooseManualPublication({
      headCommit: COMMIT_A,
      headAtLastCheck: COMMIT_A,
      verifiedPairs: [pair()],
      highWaterMark: 5,
      now: '2026-08-24T12:00:00Z',
      retentionDays: mod.SNAPSHOT_RETENTION_DAYS,
      actor: 'pgorbachev',
      ...input,
    });
  };

  // Сценарий: ручной запуск, вершина не сдвинулась
  it('из нескольких пар вершины выкладывается НОВЕЙШАЯ, и она названа', async () => {
    const decision = await manual({
      verifiedPairs: [
        pair({ snapshotId: 'snap-вчера', revision: 5, referenceDate: '2026-08-23', capturedAt: '2026-08-23T03:00:00Z' }),
        pair({ snapshotId: 'snap-сегодня', revision: 5, referenceDate: '2026-08-24', capturedAt: '2026-08-24T03:00:00Z' }),
      ],
    });

    expect(decision.action).toBe('publish');
    expect(decision.pair?.snapshotId, 'выложено вчерашнее календарное состояние без объявления отката').toBe(
      'snap-сегодня',
    );
  });

  it('при разной ревизии новизну решает ревизия, а не опорная дата', async () => {
    const decision = await manual({
      highWaterMark: 6,
      verifiedPairs: [
        pair({ snapshotId: 'snap-новее', revision: 6, referenceDate: '2026-08-23', capturedAt: '2026-08-23T03:00:00Z' }),
        pair({ snapshotId: 'snap-старее', revision: 5, referenceDate: '2026-08-24', capturedAt: '2026-08-24T03:00:00Z' }),
      ],
    });
    expect(decision.pair?.snapshotId).toBe('snap-новее');
  });

  // Сценарий: новейшая проверенная пара отстала от контента
  it('ревизия новейшей пары ниже отметки — отказ с указанием, что контент новее', async () => {
    const decision = await manual({ highWaterMark: 9, verifiedPairs: [pair({ revision: 5 })] });

    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('content-newer-than-verified-pair');
  });

  // Сценарий: для вершины проверенной пары нет
  it('без проверенной пары для вершины — отказ, и живая система управления не опрашивается', async () => {
    const decision = await manual({ verifiedPairs: [pair({ commit: COMMIT_B })] });

    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('no-verified-pair-for-head');
  });

  it('пара с неуспешным прогоном проверенной не считается', async () => {
    const decision = await manual({ verifiedPairs: [pair({ testRunConclusion: 'failure' })] });
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('no-verified-pair-for-head');
  });

  // Сценарии: подтверждённый откат на более старую проверенную пару; подтверждённый откат на
  // перекрытый коммит
  it('подтверждённый откат выкладывает названную пару перекрытого коммита и фиксирует факт', async () => {
    const decision = await manual({
      headCommit: COMMIT_B,
      headAtLastCheck: COMMIT_B,
      verifiedPairs: [pair({ commit: COMMIT_A, snapshotId: 'snap-старая', revision: 2 })],
      highWaterMark: 9,
      rollback: { snapshotId: 'snap-старая', confirmed: true, reasonHeadNotPublished: 'у вершины пары нет' },
    });

    expect(decision.action).toBe('publish');
    expect(decision.pair?.snapshotId).toBe('snap-старая');
    expect(decision.rollbackRecord?.actor).toBe('pgorbachev');
    expect(decision.rollbackRecord?.snapshotId).toBe('snap-старая');
    expect(decision.rollbackRecord?.reasonHeadNotPublished).toBeTruthy();
  });

  // Сценарий: ручная выкладка старой пары не пишет в журнал происхождения
  it('ручная выкладка старой пары в журнал происхождения не пишет', async () => {
    const decision = await manual({
      headCommit: COMMIT_B,
      headAtLastCheck: COMMIT_B,
      verifiedPairs: [pair({ commit: COMMIT_A, snapshotId: 'snap-старая', revision: 2 })],
      highWaterMark: 9,
      rollback: { snapshotId: 'snap-старая', confirmed: true, reasonHeadNotPublished: 'у вершины пары нет' },
    });

    expect(decision.writesProvenanceEntry).toBe(false);
  });

  // Сценарий: откат без подтверждения не выполняется
  it('указание пары без подтверждения ничего не публикует', async () => {
    const decision = await manual({
      headCommit: COMMIT_B,
      headAtLastCheck: COMMIT_B,
      verifiedPairs: [pair({ commit: COMMIT_A, snapshotId: 'snap-старая', revision: 2 })],
      highWaterMark: 9,
      rollback: { snapshotId: 'snap-старая', confirmed: false },
    });

    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('rollback-not-confirmed');
  });

  // Сценарий: пара старше срока хранения не выкладывается
  it('пара старше названного срока хранения снимка получает отказ', async () => {
    const mod = await gateModule();
    expect(mod.SNAPSHOT_RETENTION_DAYS, 'срок хранения обязан быть названным числом').toBeGreaterThan(0);

    const tooOld = new Date(
      Date.parse('2026-08-24T12:00:00Z') - (mod.SNAPSHOT_RETENTION_DAYS + 1) * 86_400_000,
    ).toISOString();

    const decision = await manual({
      headCommit: COMMIT_B,
      headAtLastCheck: COMMIT_B,
      verifiedPairs: [pair({ commit: COMMIT_A, snapshotId: 'snap-древняя', revision: 2, capturedAt: tooOld })],
      highWaterMark: 9,
      rollback: { snapshotId: 'snap-древняя', confirmed: true, reasonHeadNotPublished: 'откат' },
    });

    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('snapshot-beyond-retention');
  });

  // Сценарий: ручной запуск, вершина сдвинулась во время сборки
  it('сдвиг вершины к моменту выкладки останавливает и ручной путь', async () => {
    const decision = await manual({ headCommit: COMMIT_A, headAtLastCheck: COMMIT_B });

    expect(decision.action).toBe('refuse');
    expect(decision.reason).toBe('head-moved');
  });

  // Сценарий: ручной запуск не обходит прогон
  it('ручной путь не выкладывает содержимое без успешного прогона', async () => {
    const decision = await manual({
      verifiedPairs: [pair({ testRunConclusion: 'cancelled' }), pair({ testRunConclusion: 'missing' })],
    });
    expect(decision.action).toBe('refuse');
  });
});
