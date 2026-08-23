/**
 * Test-only контракт для change `cms-content-authoring-and-migration` (сторона
 * системы управления и переноса).
 *
 * Приём взят у существующего `web/tests/helpers/dependency-update-gates-contract.ts`:
 * интерфейсы объявлены здесь, реализация подгружается ДИНАМИЧЕСКИ. Отсюда два
 * свойства, ради которых так и сделано:
 *
 *  - тесты КРАСНЫЕ до появления реализации: импорт падает в момент прогона сценария,
 *    а не при сборе набора, поэтому падает именно проверка, а не весь файл;
 *  - `tsc --noEmit` остаётся чистым: ни одна строка не ссылается ТИПОМ на
 *    отсутствующий файл.
 *
 * Швы — расположение модулей и подписи функций — выбраны СЕССИЕЙ ТЕСТОВ, а не
 * спекой: спека говорит о поведении, а не о модулях. Реализация обязана дать эти
 * подписи либо назвать, чем их заменила; проверяемое поведение при этом то же.
 */

export type RecordType =
  | 'institute'
  | 'course-group'
  | 'seminar'
  | 'person'
  | 'article'
  | 'video-playlist'
  | 'static-page';

/** Каталоги адресов по типу записи: адрес плоский, каталог следует из типа. */
export const CATALOG_BY_TYPE: Readonly<Record<Exclude<RecordType, 'static-page'>, string>> = {
  institute: '/instituty',
  'course-group': '/programmy',
  seminar: '/seminary',
  person: '/specialisty',
  article: '/statyi',
  'video-playlist': '/video',
};

export interface RecordRef {
  /** Устойчивый идентификатор записи в системе управления (не адресный). */
  id: string;
  type: RecordType;
  identifier: string;
  /** Прежние адреса: адрес старого сайта и адрес нынешнего маршрута, если различны. */
  previousAddresses?: string[];
}

export interface AddressState {
  records: RecordRef[];
  /**
   * История адресов. Переживает удаление владельца, поэтому владелец назван
   * идентификатором записи, а не ссылкой на неё.
   */
  addressHistory: { address: string; ownerId: string }[];
  /**
   * Сегменты первого уровня, занятые маршрутами сборки, включая сегменты каталогов.
   * Приходит АРГУМЕНТОМ: спека запрещает держать перечень занятых сегментов в тексте
   * правила — перечень отстаёт от появления нового маршрута молча.
   */
  buildRouteSegments: string[];
}

export interface Verdict {
  ok: boolean;
  message: string;
  /** Запись, за которой закреплён конфликтующий идентификатор или адрес. */
  conflictWith?: string;
}

export interface ContentAddress {
  isValidIdentifier(identifier: string): boolean;
  addressOf(record: { type: RecordType; identifier: string }): string;
  checkIdentifier(input: { record: RecordRef; state: AddressState }): Verdict;
  /** Перенаправления из истории: каждое ведёт на ТЕКУЩИЙ адрес записи одним переходом. */
  redirectsFor(input: { recordId: string; state: AddressState }): { from: string; to: string }[];
}

export type DocumentsState = 'issued' | 'not-issued' | 'unconfirmed';
export type PriorEducation = 'none' | 'medical' | 'physical-or-pedagogical' | 'other';
export type LearningOutcome =
  | 'completed'
  | 'assessment-failed'
  | 'partially-completed'
  | 'expelled';

export interface DocumentRecord {
  document: string;
  issuer: string;
  priorEducation?: PriorEducation;
  /** Обязателен при `priorEducation: 'other'`. */
  priorEducationNote?: string;
  outcome?: LearningOutcome;
  /** Реестр или баллы НМО: за что начисляются. */
  basis?: string;
}

export interface SeminarDocuments {
  identifier: string;
  documentsState: DocumentsState;
  documents: DocumentRecord[];
}

export type PresentationForm = 'compliance-row' | 'not-issued-row' | 'unconfirmed-list';

export interface PublicationVerdict {
  ok: boolean;
  /** Имена незаполненных обязательных полей. */
  missing: string[];
  message: string;
}

export interface ContentValidation {
  requiredFields(type: string): string[];
  checkPublication(input: { type: string; record: Record<string, unknown> }): PublicationVerdict;
  /** Черновик сохраняется всегда; предупреждения отдельны от отказа. */
  checkDraftSave(input: { type: string; record: Record<string, unknown> }): {
    saved: boolean;
    warnings: string[];
  };
  checkCategoryFlagRemoval(input: {
    programIdentifier: string;
    articles: { identifier: string; categories: string[]; published: boolean }[];
  }): Verdict & { blockingArticles: string[] };
  checkDocumentsStateChange(input: {
    from: DocumentsState;
    to: DocumentsState;
    confirmation?: { date: string; source: string; author: string };
  }): Verdict;
  /** Одна запись набора: не больше одного значения по каждому основанию. */
  checkDocumentRecord(record: DocumentRecord): Verdict;
  /**
   * Состав преподавателей института. Источник — СВЯЗЬ, а не легаси-поле: у новой записи
   * легаси-поля нет по определению, и она не попала бы в состав, будучи связанной.
   */
  instituteMembers(input: {
    instituteId: string;
    persons: {
      id: string;
      trait: 'teacher' | 'method-author';
      instituteIds: string[];
      legacyInstitute?: string;
    }[];
  }): string[];
  /** Педагогические работники «Сведений об организации» — только признак «преподаватель». */
  pedagogicalStaff(
    persons: { id: string; trait: 'teacher' | 'method-author' }[],
  ): string[];
  presentationFormOf(seminar: SeminarDocuments): PresentationForm;
  aggregateCompliance(seminars: SeminarDocuments[]): {
    rows: {
      seminar: string;
      priorEducation: PriorEducation;
      document: string;
      issuer: string;
      outcome?: LearningOutcome;
    }[];
    notIssued: string[];
    unconfirmed: string[];
  };
}

export interface RevisionStore {
  read(recordId: string): { revision: string; value: unknown } | undefined;
  /** Условная запись: применяется, только если текущая ревизия равна ожидаемой. */
  compareAndSet(recordId: string, expectedRevision: string, value: unknown): boolean;
}

export interface PanelMapEntry {
  url: string;
  heading: string;
  field: string;
}

export interface Migration {
  /**
   * Сравнение текущего состояния записи с КОНТРОЛЬНОЙ ТОЧКОЙ, оставленной предыдущим
   * прогоном. Сравнение внутри одного прогона требованию не удовлетворяет.
   */
  checkpointVerdict(input: {
    recordId: string;
    /** Текущее состояние записи в системе управления; `undefined` — записи ещё нет. */
    current?: string;
    checkpoint?: { recordId: string; revision: string };
  }): { action: 'write' | 'stop'; message: string };
  /**
   * Состояние сведений о документах, выводимое из ИСХОДНОГО материала. Отсутствие
   * сведений не толкуется как «документы не выдаются».
   */
  documentsStateFromSource(source: { hasDocumentsPanel: boolean }): DocumentsState;
  /** Сравнение и запись — одной операцией. */
  applyRecord(input: {
    store: RevisionStore;
    recordId: string;
    expectedRevision: string;
    value: unknown;
  }): { applied: boolean; reason: string };
  previousAddressCoverage(input: {
    migrated: { id: string; previousAddresses: string[] }[];
  }): { migratedCount: number; withPreviousAddress: number; ok: boolean; missing: string[] };
  panelField(input: { url: string; heading: string; map: PanelMapEntry[] }):
    | { field: string }
    | { stop: true; message: string };
  /** Ключ повторяемости медиа: по содержимому файла или его источнику, не по памяти прогона. */
  mediaKey(file: { bytes: Uint8Array; sourceUrl: string }): string;
  /** Состояние записи, дошедшей до системы управления частично. */
  resumeVerdict(input: {
    recordId: string;
    cmsRecord: Record<string, unknown> | undefined;
    requiredRelations: string[];
  }): { action: 'complete' | 'replace' | 'skip'; complete: boolean; message: string };
  reconcile(input: {
    source: { type: string; ids: string[] }[];
    cms: { type: string; ids: string[] }[];
    mediaReferences?: { recordId: string; file: string }[];
    cmsMedia?: string[];
  }): {
    ok: boolean;
    countMismatch: { type: string; source: number; cms: number }[];
    deletions: { type: string; id: string }[];
    mediaMissing: { recordId: string; file: string }[];
    message: string;
  };
  /** Годность материала переноса: представляет ли он ОДНО состояние старого сайта. */
  acceptMaterial(input: {
    method: 'freeze' | 'atomic-dump' | 'crawl-with-revision';
    mediaCoverage?: 'freeze' | 'storage-snapshot' | 'proven-immutable' | 'byte-mark' | 'none';
    revisionBefore?: string;
    revisionAfter?: string;
    revisionCoversMediaBytes?: boolean;
  }): Verdict;
}

const load = async <T>(relative: string): Promise<T> => {
  const href = new URL(relative, import.meta.url).href;
  return (await import(/* @vite-ignore */ href)) as T;
};

export const CONTENT_ADDRESS_MODULE = './cms-content-address.ts';
export const CONTENT_VALIDATION_MODULE = './cms-publication-validation.ts';
export const MIGRATION_MODULE = './cms-migration.ts';

export const loadContentAddress = (): Promise<ContentAddress> =>
  load<ContentAddress>(CONTENT_ADDRESS_MODULE);
export const loadContentValidation = (): Promise<ContentValidation> =>
  load<ContentValidation>(CONTENT_VALIDATION_MODULE);
export const loadMigration = (): Promise<Migration> => load<Migration>(MIGRATION_MODULE);

/** Хранилище с ревизиями для проверки атомарности «сравнение → запись». */
export function makeRevisionStore(
  initial: Record<string, { revision: string; value: unknown }>,
): RevisionStore & { setOutOfBand(recordId: string, revision: string, value: unknown): void } {
  const state = new Map(Object.entries(initial));
  return {
    read: (recordId) => state.get(recordId),
    compareAndSet: (recordId, expectedRevision, value) => {
      const current = state.get(recordId);
      if (!current || current.revision !== expectedRevision) return false;
      state.set(recordId, { revision: `${current.revision}+1`, value });
      return true;
    },
    setOutOfBand: (recordId, revision, value) => {
      state.set(recordId, { revision, value });
    },
  };
}
