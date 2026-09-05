import type { Snapshot } from './content-snapshot.ts';

/** Группа обязательных полей: достаточно любого имени из группы (design.md, change
 *  `cms-live-snapshot-capture`). Перечислена явно, а не выведена из кода ниже: полнота
 *  соответствия полей меряется относительно ЭТОГО списка, а не относительно текста функции. */
export interface RequiredFieldGroup {
  type: string;
  anyOf: readonly string[];
}

export const REQUIRED_SNAPSHOT_FIELDS: readonly RequiredFieldGroup[] = [
  { type: 'articles', anyOf: ['slug'] },
  { type: 'articles', anyOf: ['title'] },
  { type: 'articles', anyOf: ['body', 'body_html'] },
  { type: 'articles', anyOf: ['page_title', 'seo_title'] },
  { type: 'articles', anyOf: ['page_description', 'seo_description'] },
  { type: 'articles', anyOf: ['image'] },
] as const;

/**
 * Связи, которые контракт проверяет ОТДЕЛЬНЫМ правилом (`broken-relation`), а не как пустое
 * обязательное поле. Перечень заведён отдельно намеренно: правила разные, и сваливать их в
 * `REQUIRED_SNAPSHOT_FIELDS` значило бы ждать от мутации не того нарушения.
 *
 * Он существует потому, что без него объявленное расходилось с применяемым: полнота
 * соответствия полей была зелёной, а контракт на живом снимке отказывал по связи преподавателя
 * с институтом — её просто не было в модели CMS, и заметить это до прогона было нечем.
 */
export const REQUIRED_SNAPSHOT_RELATIONS: readonly RequiredFieldGroup[] = [
  { type: 'seminars', anyOf: ['program', 'course_group_legacy_id'] },
  { type: 'course_groups', anyOf: ['institute', 'institute_legacy_id'] },
  { type: 'teachers', anyOf: ['institute', 'institute_legacy_id'] },
  { type: 'schedule_entries', anyOf: ['seminar'] },
] as const;

export interface ContractViolation {
  type: string;
  recordId: string;
  field?: string;
  rule: 'required-field-empty' | 'duplicate-identifier' | 'broken-relation' | 'slug-not-url-safe';
  relatedRecordIds?: string[];
}

const URL_SAFE_SLUG = /^[A-Za-z0-9._~-]+$/;

function recordId(record: Record<string, unknown>): string {
  if (typeof record.slug === 'string' && record.slug !== '') return record.slug;
  if (record.id !== undefined && record.id !== null && record.id !== '') return String(record.id);
  return '';
}

function isEmpty(value: unknown): boolean {
  return value == null || value === '';
}

function firstPresent(record: Record<string, unknown>, names: string[]): { field: string; value: unknown } {
  for (const field of names) {
    if (Object.prototype.hasOwnProperty.call(record, field)) return { field, value: record[field] };
  }
  return { field: names[0]!, value: undefined };
}

function requireGroup(
  type: string,
  record: Record<string, unknown>,
  names: string[],
  violations: ContractViolation[],
): void {
  const { field, value } = firstPresent(record, names);
  if (isEmpty(value)) {
    violations.push({ type, recordId: recordId(record), field, rule: 'required-field-empty' });
  }
}

function slugsOf(records: Record<string, unknown>[] | undefined): Set<string> {
  return new Set((records ?? []).map(recordId).filter(Boolean));
}

function checkDuplicates(
  type: string,
  records: Record<string, unknown>[],
  keyOf: (record: Record<string, unknown>) => string,
  violations: ContractViolation[],
): void {
  const groups = new Map<string, string[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (!key) continue;
    const id = recordId(record);
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    violations.push({
      type,
      recordId: ids[0]!,
      rule: 'duplicate-identifier',
      relatedRecordIds: ids,
    });
  }
}

export function validateSnapshotContract(snapshot: Snapshot): { ok: boolean; violations: ContractViolation[] } {
  const violations: ContractViolation[] = [];
  const types = snapshot.content.types;
  const articles = types.articles ?? [];
  const seminars = types.seminars ?? [];
  const programs = types.programs ?? types.course_groups ?? [];
  const institutes = types.institutes ?? [];
  const teachers = types.teachers ?? [];
  const schedule = types.schedule ?? types.schedule_entries ?? [];

  for (const article of articles) {
    requireGroup('articles', article, ['slug'], violations);
    requireGroup('articles', article, ['title'], violations);
    requireGroup('articles', article, ['body', 'body_html'], violations);
    requireGroup('articles', article, ['page_title', 'seo_title'], violations);
    requireGroup('articles', article, ['page_description', 'seo_description'], violations);
    requireGroup('articles', article, ['image'], violations);
    const slug = typeof article.slug === 'string' ? article.slug : '';
    if (slug && !URL_SAFE_SLUG.test(slug)) {
      violations.push({ type: 'articles', recordId: slug, rule: 'slug-not-url-safe' });
    }
  }
  checkDuplicates('articles', articles, (r) => String(r.slug ?? ''), violations);

  const programSlugs = slugsOf(programs);
  const instituteSlugs = slugsOf(institutes);
  const seminarSlugs = slugsOf(seminars);

  if (types.programs || types.course_groups) {
    // Сравнивать надо ОДНОРОДНОЕ с однородным. Семинар ссылается на программу двумя разными
    // способами, и они живут в разных пространствах имён: `program` — это слуг, а
    // `course_group_legacy_id` — идентификатор legacy-сайта, что видно прямо из имени поля.
    // Прежняя редакция брала любое из двух и искала в множестве СЛУГОВ, поэтому объявляла
    // сломанными все 126 связей при том, что по legacy_id целы все 126.
    const programLegacyIds = new Set(
      (programs ?? []).map((record) => String(record.legacy_id ?? '')).filter(Boolean),
    );
    for (const seminar of seminars) {
      const bySlug = seminar.program;
      const byLegacyId = seminar.course_group_legacy_id;
      const linked = !isEmpty(bySlug)
        ? programSlugs.has(String(bySlug))
        : !isEmpty(byLegacyId) && programLegacyIds.has(String(byLegacyId));
      if (!linked) {
        violations.push({ type: 'seminars', recordId: recordId(seminar), rule: 'broken-relation' });
      }
    }
  }

  if (types.institutes) {
    for (const program of programs) {
      const institute = program.institute ?? program.institute_legacy_id;
      if (isEmpty(institute) || !instituteSlugs.has(String(institute))) {
        violations.push({ type: 'programs', recordId: recordId(program), rule: 'broken-relation' });
      }
    }
    for (const teacher of teachers) {
      const institute = teacher.institute ?? teacher.institute_legacy_id;
      if (isEmpty(institute) || !instituteSlugs.has(String(institute))) {
        violations.push({ type: 'teachers', recordId: recordId(teacher), rule: 'broken-relation' });
      }
    }
  }

  if (types.seminars && (types.schedule || types.schedule_entries)) {
    for (const event of schedule) {
      const seminar =
        typeof event.seminar === 'string'
          ? event.seminar
          : event.seminar && typeof event.seminar === 'object'
            ? (event.seminar as { slug?: unknown }).slug
            : undefined;
      if (isEmpty(seminar) || !seminarSlugs.has(String(seminar))) {
        violations.push({ type: 'schedule', recordId: recordId(event), rule: 'broken-relation' });
      }
    }
  }

  checkDuplicates(
    'seminars',
    seminars,
    (r) => `${String(r.program ?? r.course_group_legacy_id ?? '')}::${String(r.slug ?? '')}`,
    violations,
  );

  return { ok: violations.length === 0, violations };
}

export function assertSnapshotContract(snapshot: Snapshot): void {
  const { violations } = validateSnapshotContract(snapshot);
  if (violations.length === 0) return;
  const first = violations[0]!;
  const field = first.field ? ` ${first.field}` : '';
  throw new Error(`${first.recordId}${field} ${first.rule}`);
}
