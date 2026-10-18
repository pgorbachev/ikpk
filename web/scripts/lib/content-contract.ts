import type { Snapshot } from './content-snapshot.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      // Участие в институте — необязательная relation. Если она задана, snapshot обязан
      // ссылаться на существующий институт; отсутствие связи публикации не мешает.
      if (!isEmpty(institute) && !instituteSlugs.has(String(institute))) {
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
  const demo = snapshot as Snapshot & {
    sourcePolicy?: unknown; sourceAge?: unknown; captureProof?: Record<string, unknown>;
  };
  if (demo.sourcePolicy !== undefined || demo.sourceAge !== undefined || demo.captureProof !== undefined) {
    const proof = demo.captureProof;
    const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (demo.sourcePolicy !== 'demo-publication-only' || demo.sourceAge !== 'untracked'
        || snapshot.origin?.kind !== 'server-db' || snapshot.origin.sourceId !== 'demo193-cms'
        || !proof || proof.version !== 1 || proof.method !== 'quiesced-sqlite-backup'
        || proof.sourceId !== 'demo193-cms' || typeof proof.captureId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.captureId)
        || !digest(proof.schemaDigest) || !digest(proof.databaseDigest)
        || !digest(proof.mediaManifestDigest) || !digest(proof.bundleDigest)) {
      throw new Error('staging193 publication snapshot has incomplete or invalid sealed capture proof');
    }
  }
  const { violations } = validateSnapshotContract(snapshot);
  if (violations.length === 0) return;
  // Отказ обязан называть ПРЕДМЕТ, а не только первую запись: сообщение вида
  // «85 broken-relation» не говорит ни какая связь сломана, ни сколько их — по нему
  // нельзя отличить один дефект данных от насыщенной проверки, которая красна на всём.
  const byRule = new Map<string, number>();
  for (const v of violations) {
    const key = `${v.type}.${v.field ?? '—'} ${v.rule}`;
    byRule.set(key, (byRule.get(key) ?? 0) + 1);
  }
  const summary = [...byRule.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ×${count}`)
    .join('; ');
  const examples = violations.slice(0, 3).map((v) => v.recordId).join(', ');
  throw new Error(`контракт снимка нарушен: ${violations.length} — ${summary}. Примеры: ${examples}`);
}

/**
 * Prototype-only acceptance for the exact article SEO holes approved for demo193.
 * The ordinary snapshot/publication contract remains strict; callers must provide
 * the source SQL digest, while this helper pins both that digest and the allowlist
 * bytes. Empty CMS values are preserved in the snapshot, never filled here.
 */
export function assertPrototypeDemo193SnapshotContract(snapshot: Snapshot, sourceSqlSha256: string): void {
  const expectedSqlSha256 = 'b7b056d6a226b9caed224c737dad18dc366d47a0ec397e0ef0f1c66f61762be2';
  const expectedAllowlistSha256 = 'b6a46a6138157cb77be55ecfbe8b05e962e827be6fc807fc8a34ded92e3916f5';
  if (sourceSqlSha256 !== expectedSqlSha256) throw new Error('demo193 SQL source pin mismatch');

  const allowlistPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../cms/src/lib/demo193-source-empty-fields.json');
  const allowlistBytes = readFileSync(allowlistPath);
  if (createHash('sha256').update(allowlistBytes).digest('hex') !== expectedAllowlistSha256) {
    throw new Error('demo193 source-empty-fields allowlist pin mismatch');
  }
  const allowlist = JSON.parse(allowlistBytes.toString('utf8')) as {
    sourceSqlSha256?: unknown;
    entries?: { type?: unknown; legacyId?: unknown; slug?: unknown; fields?: unknown }[];
  };
  if (allowlist.sourceSqlSha256 !== expectedSqlSha256 || !Array.isArray(allowlist.entries)) {
    throw new Error('demo193 source-empty-fields SQL pin mismatch');
  }

  const articleEntries = allowlist.entries.filter((entry) => entry.type === 'article');
  if (articleEntries.length !== 66) throw new Error('demo193 article SEO allowlist count mismatch');
  const aliases: Record<string, string> = {
    seo_title: 'page_title',
    seo_description: 'page_description',
  };
  const expected = new Set<string>();
  for (const entry of articleEntries) {
    if (typeof entry.legacyId !== 'string' || typeof entry.slug !== 'string' || !Array.isArray(entry.fields)) {
      throw new Error('demo193 article SEO allowlist entry is malformed');
    }
    if (entry.fields.length !== 2 || !entry.fields.includes('seo_title') || !entry.fields.includes('seo_description')) {
      throw new Error(`demo193 article SEO allowlist fields mismatch for ${entry.slug}`);
    }
    for (const sourceField of entry.fields) {
      const field = aliases[sourceField];
      if (!field) throw new Error(`demo193 article SEO allowlist has unsupported field for ${entry.slug}`);
      const record = (snapshot.content.types.articles ?? []).find(
        (article) => article.legacy_id === entry.legacyId && article.slug === entry.slug,
      );
      if (!record || !isEmpty(record[field])) throw new Error(`demo193 approved empty SEO source changed for ${entry.slug}.${field}`);
      expected.add(`articles|${entry.slug}|${field}|required-field-empty`);
    }
  }
  if (expected.size !== 132) throw new Error('demo193 article SEO allowlist tuple count mismatch');

  const violations = validateSnapshotContract(snapshot).violations;
  const observedAllowed = new Set<string>();
  const unexpected = violations.filter((violation) => {
    const key = `${violation.type}|${violation.recordId}|${violation.field ?? ''}|${violation.rule}`;
    if (expected.has(key) && !observedAllowed.has(key)) {
      observedAllowed.add(key);
      return false;
    }
    return true;
  });
  if (unexpected.length > 0 || observedAllowed.size !== expected.size) {
    const missing = [...expected].filter((key) => !observedAllowed.has(key));
    throw new Error(
      `demo193 snapshot contract mismatch: unexpected ${unexpected.length}, approved holes ${observedAllowed.size}/${expected.size}` +
        (missing.length ? `; missing approved holes: ${missing.slice(0, 3).join(', ')}` : ''),
    );
  }
}
