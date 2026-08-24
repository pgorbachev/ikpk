// Контракт модулей, которых ЕЩЁ НЕТ: change `cms-content-publication`.
//
// Тесты по спеке пишутся раньше реализации (AGENTS.md, «Тесты по спеке пишутся в отдельной
// сессии и раньше кода»), поэтому здесь объявлен интерфейс будущих модулей, а сами модули
// загружаются ДИНАМИЧЕСКИ. Причина именно такая, а не стилистическая:
//
//  - статический `import` несуществующего модуля валит `astro check` целиком, и тогда
//    красный прогон нельзя отличить от сломанного дерева. Динамическая загрузка по
//    переменной оставляет typecheck зелёным, а прогон — красным, то есть красное относится
//    к отсутствию реализации, а не к тесту;
//  - загрузка идёт ВНУТРИ каждого теста, а не на верхнем уровне файла: тогда каждый сценарий
//    краснеет своим именем и зеленеет самостоятельно по мере появления реализации. Загрузка
//    в `beforeAll` уронила бы весь файл одной ошибкой, и по прогону нельзя было бы судить,
//    какой сценарий закрыт.
//
// Имена и формы взяты из спеки (`openspec/changes/cms-content-publication/specs/`), а не
// придуманы: «отпечаток контента», «идентификатор снимка», «номер наблюдённой записи»,
// «ревизия контента», «высшая достигнутая отметка», маркеры событий. Реализация вправе
// выбрать другое РАСПОЛОЖЕНИЕ модулей, но тогда обязана поправить константы путей здесь —
// это единственное место, где они названы.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_ROOT = join(import.meta.dirname, '..', '..');
export const REPO_ROOT = join(WEB_ROOT, '..');

/** Пути будущих модулей. Единственное место, где они названы. */
export const MODULES = {
  snapshot: '../../scripts/lib/content-snapshot.ts',
  capture: '../../scripts/lib/content-capture.ts',
  contract: '../../scripts/lib/content-contract.ts',
  ledger: '../../scripts/lib/provenance-ledger.ts',
  publishGate: '../../scripts/lib/publish-gate.ts',
  mediaStore: '../../scripts/lib/content-media-store.ts',
  publishedState: '../../scripts/lib/published-state.ts',
} as const;

/** Тот же путь от корня репозитория — для сообщений и для проверок существования. */
export function modulePathOnDisk(specifier: string): string {
  return join(WEB_ROOT, 'tests', 'helpers', specifier);
}

/**
 * Загружает будущий модуль. Отсутствие модуля — понятный отказ с указанием файла, который
 * реализация обязана создать, а не `Cannot find module '../../scripts/lib/…'` из глубины
 * загрузчика.
 */
export async function loadModule<T>(specifier: string): Promise<T> {
  const onDisk = modulePathOnDisk(specifier);
  if (!existsSync(onDisk)) {
    throw new Error(
      `НЕ РЕАЛИЗОВАНО: ожидается модуль ${onDisk}. ` +
        `Тест написан по утверждённой спеке cms-content-publication раньше реализации.`,
    );
  }
  return (await import(/* @vite-ignore */ specifier)) as T;
}

// ------------------------------------------------------------------ снимок

/** Медиафайл снимка: идентификатор содержимого обязателен, байты — по месту хранения. */
export interface SnapshotMedia {
  /** Ссылка, по которой на файл ссылается контент. */
  ref: string;
  /** Идентификатор СОДЕРЖИМОГО (не путь и не имя): по нему проверяется прочитанное. */
  contentId: string;
}

export interface SnapshotContent {
  /** Записи по типам контента: `articles`, `seminars`, `programs`, … */
  types: Record<string, Record<string, unknown>[]>;
  media: SnapshotMedia[];
}

export interface SnapshotProvenanceNumbers {
  /** Номер последней записи журнала на момент снятия снимка. */
  observedEntry: number;
  /** Производная ревизия контента; `null` — не определяется, нужно подтверждение. */
  revision: number | null;
  highWaterMark: number;
}

export interface Snapshot {
  content: SnapshotContent;
  /** Опорная дата снимка, `YYYY-MM-DD`. */
  referenceDate: string;
  /** Закреплённый снимок-фикстура: опорная дата берётся из него, а не из календаря. */
  pinned?: boolean;
  provenance?: SnapshotProvenanceNumbers;
}

export interface SnapshotModule {
  /**
   * Отпечаток контента: каноническая форма, БЕЗ опорной даты, с идентификаторами
   * содержимого медиа.
   */
  contentFingerprint(content: SnapshotContent): string;
  /** Идентификатор снимка: отпечаток контента И опорная дата. */
  snapshotId(input: { fingerprint: string; referenceDate: string }): string;
  /**
   * Опорная дата, которой собирают из этого снимка. У закреплённого — своя,
   * у живого — календарь прогона в заданном поясе.
   */
  referenceDateOf(snapshot: Snapshot, run: { calendarToday: string }): string;
  /** Часовой пояс опорной даты — задан явно, не наследуется от машины. */
  REFERENCE_TIMEZONE: string;
}

// ---------------------------------------------------------------- снятие снимка

export type CaptureFailureKind =
  | 'unreachable'
  | 'request-failed'
  | 'truncated'
  | 'pagination-gap'
  | 'changed-during-capture'
  | 'mixed-state'
  | 'below-minimum-cardinality'
  | 'unknown-count';

export interface TypeObservation {
  type: string;
  /** Сколько записей объявила система управления; `null` — не сообщила. */
  declaredCount: number | null;
  records: Record<string, unknown>[];
  /** Номера страниц постраничной выдачи в порядке обхода. */
  pages?: number[];
  requestFailed?: boolean;
}

export interface CaptureObservation {
  types: TypeObservation[];
  /** Состояние источника на начало и на конец обхода. */
  stateAtStart: string;
  stateAtEnd: string;
  reachable?: boolean;
}

export interface CaptureFailure {
  kind: CaptureFailureKind;
  type?: string;
  detail?: string;
}

export interface CaptureModule {
  assessCapture(observation: CaptureObservation): { ok: boolean; failures: CaptureFailure[] };
  /**
   * Отбор опубликованных записей. Требование записано явно, а не оставлено на умолчание
   * системы управления: умолчание контрактом не является.
   */
  selectPublished(records: Record<string, unknown>[]): Record<string, unknown>[];
  /** Минимальная мощность по типам: каркасные > 0, законно пустые = 0. */
  MINIMUM_CARDINALITY: Readonly<Record<string, number>>;
}

// -------------------------------------------------------------- контракт данных

export interface ContractViolation {
  type: string;
  /** Запись, на которой нарушено условие: требование обязывает её назвать. */
  recordId: string;
  field?: string;
  rule:
    | 'required-field-empty'
    | 'duplicate-identifier'
    | 'broken-relation'
    | 'slug-not-url-safe';
  /** Для повторяющегося идентификатора — обе записи. */
  relatedRecordIds?: string[];
}

export interface ContractModule {
  validateSnapshotContract(snapshot: Snapshot): { ok: boolean; violations: ContractViolation[] };
  /**
   * Та же проверка в форме, останавливающей сборку: бросает с указанием записи и
   * нарушенного условия. Отдельная функция нужна потому, что требование говорит не только
   * «нарушение обнаруживается», но и «сборка завершается неуспехом».
   */
  assertSnapshotContract(snapshot: Snapshot): void;
}

// ------------------------------------------------------- журнал происхождения

export type EventMarker = 'edit' | 'restore' | 'initial-migration' | 'accept-state';

export interface LedgerEntry {
  number: number;
  fingerprint: string;
  previous: number | null;
  marker: EventMarker | null;
}

export interface Observation extends SnapshotProvenanceNumbers {
  requiresConfirmation: boolean;
  reason?:
    | 'restore-with-unknown-fingerprint'
    | 'fingerprint-match-without-marker'
    | 'ledger-unavailable';
}

export interface ProvenanceLedger {
  /** Запись появляется на СОБЫТИЕ изменения контента, а не на снятие снимка. */
  recordEvent(event: { fingerprint: string; marker: EventMarker | null }): Promise<LedgerEntry>;
  entries(): Promise<readonly LedgerEntry[]>;
  highWaterMark(): Promise<number>;
  /** Два числа снимка плюс вердикт «нужно ли подтверждение». */
  observe(state: { fingerprint: string }): Promise<Observation>;
  /** Подтверждение восстановленной базы: маркер «принятие состояния». */
  acceptState(state: { fingerprint: string; confirmedBy: string }): Promise<LedgerEntry>;
}

export interface LedgerModule {
  createLedger(options: {
    dir: string;
    /** Публиковался ли сайт ранее: пустой журнал при непустой истории — не «всё новое». */
    hasPublicationHistory?: boolean;
  }): ProvenanceLedger;
}

// ------------------------------------------------------------- гейт публикации

export type PublicationAction =
  | 'publish'
  | 'cancel-stale'
  | 'require-confirmation'
  | 'refuse';

export interface PublicationDecision {
  action: PublicationAction;
  reason?: string;
  /** Отмена устаревшей выкладки записывается. */
  recorded?: boolean;
  /** Для состояния последней записи журнала гарантирован прогон. */
  runScheduledForLatestEntry?: boolean;
}

export interface VerifiedPair {
  commit: string;
  snapshotId: string;
  revision: number;
  /** Опорная дата снимка, `YYYY-MM-DD`: при равной ревизии новизну решает она. */
  referenceDate: string;
  /** Когда снимок снят, ISO — для срока хранения. */
  capturedAt: string;
  testRunConclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'missing';
}

export interface ManualPublicationDecision {
  action: 'publish' | 'refuse';
  pair?: VerifiedPair;
  reason?:
    | 'no-verified-pair-for-head'
    | 'content-newer-than-verified-pair'
    | 'rollback-not-confirmed'
    | 'snapshot-beyond-retention'
    | 'head-moved';
  /** Подтверждённый откат фиксируется: кто, какая пара, почему не вершина. */
  rollbackRecord?: { actor: string; snapshotId: string; reasonHeadNotPublished: string };
  /** Пишет ли решение в журнал происхождения контента: ручная выкладка — не пишет. */
  writesProvenanceEntry?: boolean;
}

export interface PublishGateModule {
  /**
   * Устаревание против регресса. Устаревание — есть запись новее НАБЛЮДЁННОЙ; регресс —
   * наблюдённая последняя, а ревизия ниже отметки.
   */
  classifySnapshotForPublication(input: {
    observedEntry: number;
    latestEntry: number;
    revision: number | null;
    highWaterMark: number;
    confirmedBy?: string;
  }): PublicationDecision;

  /** Событийный путь: проверенная пара, актуальность вершины. */
  classifyEventDrivenPublication(input: {
    verifiedCommit: string;
    headAtLastCheck: string;
    testRunConclusion: VerifiedPair['testRunConclusion'];
  }): PublicationDecision;

  /** Ручной путь: выбрать новейшую проверенную пару вершины либо отказать. */
  chooseManualPublication(input: {
    headCommit: string;
    headAtLastCheck?: string;
    verifiedPairs: VerifiedPair[];
    highWaterMark: number;
    now: string;
    retentionDays: number;
    actor: string;
    rollback?: { snapshotId: string; confirmed: boolean; reasonHeadNotPublished?: string };
  }): ManualPublicationDecision;

  /** Названный срок хранения снимка и медиа: обещание повторной выкладки имеет границу. */
  SNAPSHOT_RETENTION_DAYS: number;
}

// --------------------------------------------------------------- хранилище медиа

export interface MediaStoreModule {
  /** Читает файл по идентификатору содержимого и ПРОВЕРЯЕТ прочитанное по нему же. */
  readFromStore(input: {
    storeDir: string;
    contentId: string;
  }): { ok: true; bytes: Uint8Array } | { ok: false; reason: 'content-id-mismatch' | 'missing'; contentId: string };
  contentIdOf(bytes: Uint8Array | string): string;
}

// ------------------------------------------------- наблюдение опубликованного

export interface PublishedStateModule {
  /**
   * Сверка опубликованного состояния, ПРОЧИТАННОГО С РАЗДАЧИ, с ожидаемым.
   * Нечитаемый ответ — непройденная проверка, а не «расхождений нет».
   */
  comparePublishedState(input: {
    expected: { commit: string; snapshotId: string };
    observed: { commit: string; snapshotId: string } | null;
  }): { status: 'match' | 'mismatch' | 'unreadable'; differing?: ('commit' | 'snapshotId')[] };
}
