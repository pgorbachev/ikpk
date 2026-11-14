/**
 * Валидация публикации и черновиков системы управления: обязательные поля по
 * типам, признак персоны, состав института, обязательная категория статьи,
 * структурные сведения о выдаваемых документах.
 *
 * Подписи заданы `./cms-authoring-contract.ts` (выбраны сессией тестов).
 */

import type {
  ContentValidation,
  DocumentRecord,
  DocumentsState,
  PresentationForm,
  PriorEducation,
  PublicationVerdict,
  SeminarDocuments,
  Verdict,
} from './cms-authoring-contract';

const REQUIRED_FIELDS: Record<string, string[]> = {
  article: ['title', 'identifier', 'body', 'seo_title', 'seo_description', 'image', 'published_at', 'categories'],
  seminar: ['name', 'identifier', 'course_group', 'description', 'documentsState'],
  'course-group': ['name', 'identifier', 'institute', 'description', 'seo_title', 'seo_description'],
  institute: ['name', 'identifier', 'description', 'seo_title', 'seo_description', 'order'],
  person: ['name', 'identifier', 'trait'],
  'schedule-entry': ['seminar', 'startAt', 'endAt', 'city', 'status'],
  'static-page': ['title', 'identifier', 'body', 'seo_title', 'seo_description'],
  'video-playlist': ['title', 'identifier'],
  'news-item': ['title', 'date', 'body'],
  promotion: ['title', 'date', 'body'],
};

const PERSON_TRAITS = new Set(['teacher', 'method-author']);

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function requiredFields(type: string): string[] {
  return REQUIRED_FIELDS[type] ?? [];
}

function checkPublication({
  type,
  record,
}: {
  type: string;
  record: Record<string, unknown>;
}): PublicationVerdict {
  const missing = requiredFields(type).filter((field) =>
    !(type === 'schedule-entry' && field === 'city' && record.isOnline === true) && isEmpty(record[field]),
  );

  if (type === 'person' && !isEmpty(record.trait)) {
    const trait = record.trait;
    if (typeof trait !== 'string' || !PERSON_TRAITS.has(trait)) {
      return { ok: false, missing, message: `недопустимое значение признака персоны: ${JSON.stringify(trait)}` };
    }
  }

  if (type === 'seminar' && record.documentsState === 'issued' && isEmpty(record.documents)) {
    return {
      ok: false,
      missing,
      message: 'состояние «выдаются» требует непустого набора записей о документах',
    };
  }

  if (missing.length > 0) {
    return { ok: false, missing, message: `не заполнены обязательные поля: ${missing.join(', ')}` };
  }
  return { ok: true, missing: [], message: 'публикация допустима' };
}

function checkDraftSave({
  record,
}: {
  type: string;
  record: Record<string, unknown>;
}): { saved: boolean; warnings: string[] } {
  // Черновик сохраняется всегда: отказ на сохранении стоит дороже
  // предупреждения — введённый текст важнее незаполненного обязательного поля.
  void record;
  return { saved: true, warnings: [] };
}

function checkCategoryFlagRemoval({
  programIdentifier,
  articles,
}: {
  programIdentifier: string;
  articles: { identifier: string; categories: string[]; published: boolean }[];
}): Verdict & { blockingArticles: string[] } {
  const blockingArticles = articles
    .filter((a) => a.published && a.categories.length === 1 && a.categories.includes(programIdentifier))
    .map((a) => a.identifier);
  return {
    ok: blockingArticles.length === 0,
    message:
      blockingArticles.length > 0
        ? `снятие признака оставит без категории: ${blockingArticles.join(', ')}`
        : 'признак можно снять',
    blockingArticles,
  };
}

function checkDocumentsStateChange({
  from,
  to,
  confirmation,
}: {
  from: DocumentsState;
  to: DocumentsState;
  confirmation?: { date: string; source: string; author: string };
}): Verdict {
  if (from === 'unconfirmed' && to !== 'unconfirmed') {
    const complete =
      !!confirmation &&
      !isEmpty(confirmation.date) &&
      !isEmpty(confirmation.source) &&
      !isEmpty(confirmation.author);
    if (!complete) {
      return {
        ok: false,
        message: 'переход из «сведения не подтверждены» требует основания: дата, источник, автор',
      };
    }
  }
  return { ok: true, message: 'переход допустим' };
}

function checkDocumentRecord(record: DocumentRecord): Verdict {
  if (isEmpty(record.document)) return { ok: false, message: 'не назван документ' };
  if (isEmpty(record.issuer) && record.issuerUnknown !== true) return { ok: false, message: 'не названо выдающее лицо' };
  if (!isEmpty(record.issuer) && record.issuerUnknown === true) return { ok: false, message: 'выдающее лицо не может быть одновременно указано и неизвестно' };
  if (record.completionScope === 'other-seminar' && isEmpty(record.otherSeminarHref)) return { ok: false, message: 'укажите ссылку на другой семинар' };
  if (Array.isArray(record.priorEducation)) {
    return { ok: false, message: 'составное значение по исходному образованию недопустимо' };
  }
  if (isEmpty(record.priorEducation)) return { ok: false, message: 'укажите требование к образованию или отметьте, что оно не указано' };
  if (Array.isArray(record.outcome)) {
    return { ok: false, message: 'составное значение по результату обучения недопустимо' };
  }
  if (record.priorEducation === 'other' && isEmpty(record.priorEducationNote)) {
    return { ok: false, message: 'значение «иное» требует уточняющего текста' };
  }
  return { ok: true, message: 'запись допустима' };
}

function instituteMembers({
  instituteId,
  persons,
}: {
  instituteId: string;
  persons: { id: string; trait: 'teacher' | 'method-author'; instituteIds: string[]; legacyInstitute?: string }[];
}): string[] {
  return persons.filter((p) => p.instituteIds.includes(instituteId)).map((p) => p.id);
}

function pedagogicalStaff(persons: { id: string; trait: 'teacher' | 'method-author' }[]): string[] {
  return persons.filter((p) => p.trait === 'teacher').map((p) => p.id);
}

function presentationFormOf(seminar: SeminarDocuments): PresentationForm {
  if (seminar.documentsState === 'not-issued') return 'not-issued-row';
  if (seminar.documentsState === 'unconfirmed') return 'unconfirmed-list';
  return 'compliance-row';
}

function aggregateCompliance(seminars: SeminarDocuments[]): {
  rows: {
    seminar: string;
    priorEducation: PriorEducation;
    document: string;
    issuer: string;
    outcome?: DocumentRecord['outcome'];
    issuerUnknown?: boolean;
    completionScope?: DocumentRecord['completionScope'];
    otherSeminarHref?: string;
    registries?: DocumentRecord['registries'];
  }[];
  notIssued: string[];
  unconfirmed: string[];
  supplemental?: { seminar: string; nmo?: SeminarDocuments['nmo']; trainingRegistries?: SeminarDocuments['trainingRegistries'] }[];
} {
  const rows: ReturnType<typeof aggregateCompliance>['rows'] = [];
  const notIssued: string[] = [];
  const unconfirmed: string[] = [];
  const supplemental: NonNullable<ReturnType<typeof aggregateCompliance>['supplemental']> = [];

  for (const s of seminars) {
    if (s.nmo || s.trainingRegistries?.length) {
      supplemental.push({ seminar: s.identifier, ...(s.nmo ? { nmo: s.nmo } : {}), ...(s.trainingRegistries?.length ? { trainingRegistries: s.trainingRegistries } : {}) });
    }
    if (s.documentsState === 'not-issued') {
      notIssued.push(s.identifier);
      continue;
    }
    if (s.documentsState === 'unconfirmed') {
      unconfirmed.push(s.identifier);
      continue;
    }
    for (const d of s.documents) {
      rows.push({
        seminar: s.identifier,
        // Контракт объявляет поле обязательным, но исходные записи из старой
        // системы не всегда называют образование (см. тест «документ по
        // непрохождению аттестации») — сохраняем значение как есть.
        priorEducation: d.priorEducation ?? 'unspecified',
        document: d.document,
        issuer: d.issuer,
        outcome: d.outcome,
        ...(d.issuerUnknown !== undefined ? { issuerUnknown: d.issuerUnknown } : {}),
        ...(d.completionScope !== undefined ? { completionScope: d.completionScope } : {}),
        ...(d.otherSeminarHref !== undefined ? { otherSeminarHref: d.otherSeminarHref } : {}),
        ...(d.registries !== undefined ? { registries: d.registries } : {}),
      });
    }
  }

  return { rows, notIssued, unconfirmed, ...(supplemental.length ? { supplemental } : {}) };
}

const contentValidation: ContentValidation = {
  requiredFields,
  checkPublication,
  checkDraftSave,
  checkCategoryFlagRemoval,
  checkDocumentsStateChange,
  checkDocumentRecord,
  instituteMembers,
  pedagogicalStaff,
  presentationFormOf,
  aggregateCompliance,
};

export default contentValidation;
export {
  requiredFields,
  checkPublication,
  checkDraftSave,
  checkCategoryFlagRemoval,
  checkDocumentsStateChange,
  checkDocumentRecord,
  instituteMembers,
  pedagogicalStaff,
  presentationFormOf,
  aggregateCompliance,
};
