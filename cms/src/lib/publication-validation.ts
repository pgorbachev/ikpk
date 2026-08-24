/**
 * СИНХРОНИЗИРОВАННАЯ КОПИЯ (частичная) `scripts/lib/cms-publication-validation.ts` — см.
 * объяснение дублирования в шапке `./content-address.ts`.
 *
 * Здесь вынесено ровно то подмножество, которое нужно на стороне Strapi (обязательные поля,
 * запись о документе, переход состояния сведений о документах, снятие признака категории);
 * `instituteMembers`/`pedagogicalStaff`/`presentationFormOf`/`aggregateCompliance` — предмет
 * стороны сборки (`web`), не lifecycle-хуков, и здесь не дублируются.
 */

export type DocumentsState = 'issued' | 'not-issued' | 'unconfirmed';
export type PriorEducation = 'none' | 'medical' | 'physical-or-pedagogical' | 'other';
export type LearningOutcome = 'completed' | 'assessment-failed' | 'partially-completed' | 'expelled';

export interface DocumentRecord {
  document: string;
  issuer: string;
  priorEducation?: PriorEducation;
  priorEducationNote?: string;
  outcome?: LearningOutcome;
  basis?: string;
}

export interface PublicationVerdict {
  ok: boolean;
  missing: string[];
  message: string;
}

export interface Verdict {
  ok: boolean;
  message: string;
  conflictWith?: string;
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  article: ['title', 'identifier', 'body', 'seo_title', 'seo_description', 'image', 'published_at', 'categories'],
  seminar: ['name', 'identifier', 'course_group', 'description', 'seo_title', 'seo_description', 'documentsState'],
  'course-group': ['name', 'identifier', 'institute', 'description', 'seo_title', 'seo_description'],
  institute: ['name', 'identifier', 'description', 'seo_title', 'seo_description', 'order'],
  person: ['name', 'identifier', 'trait'],
  'static-page': ['title', 'identifier', 'body', 'seo_title', 'seo_description'],
  'video-playlist': ['title', 'identifier'],
};

const PERSON_TRAITS = new Set(['teacher', 'method-author']);

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function requiredFields(type: string): string[] {
  return REQUIRED_FIELDS[type] ?? [];
}

export function checkPublication({
  type,
  record,
}: {
  type: string;
  record: Record<string, unknown>;
}): PublicationVerdict {
  const missing = requiredFields(type).filter((field) => isEmpty(record[field]));

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

export function checkCategoryFlagRemoval({
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

export function checkDocumentsStateChange({
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
      !!confirmation && !isEmpty(confirmation.date) && !isEmpty(confirmation.source) && !isEmpty(confirmation.author);
    if (!complete) {
      return {
        ok: false,
        message: 'переход из «сведения не подтверждены» требует основания: дата, источник, автор',
      };
    }
  }
  return { ok: true, message: 'переход допустим' };
}

export function checkDocumentRecord(record: DocumentRecord): Verdict {
  if (isEmpty(record.document)) return { ok: false, message: 'не назван документ' };
  if (isEmpty(record.issuer)) return { ok: false, message: 'не названо выдающее лицо' };
  if (Array.isArray(record.priorEducation)) {
    return { ok: false, message: 'составное значение по исходному образованию недопустимо' };
  }
  if (Array.isArray(record.outcome)) {
    return { ok: false, message: 'составное значение по результату обучения недопустимо' };
  }
  if (record.priorEducation === 'other' && isEmpty(record.priorEducationNote)) {
    return { ok: false, message: 'значение «иное» требует уточняющего текста' };
  }
  return { ok: true, message: 'запись допустима' };
}
