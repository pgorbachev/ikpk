import assert from 'node:assert/strict';
import { stripLegacySeminarTail } from '../../../src/lib/html-cleaner.js';
import type { RenderedSink } from './marker-inventory.js';

export type SnapshotContent = {
  institutes: { legacy_id: string; slug: string }[];
  course_groups: { legacy_id: string; slug: string; institute_legacy_id: string }[];
  seminars: {
    slug: string;
    course_group_legacy_id: string;
    content_format?: string | null;
    audience?: string | null;
    description_html?: string | null;
    full_text_html?: string | null;
    learning_mode?: string | null;
    learning_plan?: string | null;
    recommendations?: string | null;
  }[];
  teachers: { slug: string; institute_legacy_id?: string | null; bio_html?: string | null }[];
};

function uniqueMap<T>(items: T[], keyOf: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    assert(key, `${label}: пустой ключ`);
    assert(!result.has(key), `${label}: повторный ключ ${key}`);
    result.set(key, item);
  }
  return result;
}

function requiredSink(sinks: RenderedSink[], id: string): RenderedSink {
  const matches = sinks.filter((sink) => sink.id === id);
  assert.equal(matches.length, 1, `rendered registry должен содержать ровно один ${id}`);
  return matches[0];
}

function pathsAreUnique(paths: string[], id: string): string[] {
  assert.equal(new Set(paths).size, paths.length, `${id}: повторный route в source snapshot`);
  return paths;
}

/**
 * The checked-in registry describes the synthetic fixture corpus. Seminar and teacher sinks vary
 * with the build snapshot, so project only their exact source-backed routes here. This
 * never reads the built HTML; the inventory gate still checks every route, count and extra
 * marker against the independent rendered output.
 */
export function projectSnapshotMarkers(sinks: RenderedSink[], content: SnapshotContent): RenderedSink[] {
  for (const key of ['institutes', 'course_groups', 'seminars', 'teachers'] as const) {
    assert(Array.isArray(content[key]), `snapshot content is missing ${key}`);
  }

  const institutes = uniqueMap(content.institutes, (item) => item.slug, 'institutes');
  const courseGroups = uniqueMap(content.course_groups, (item) => item.legacy_id, 'course_groups');

  const structuredFields = ['description_html', 'audience', 'learning_plan', 'learning_mode', 'recommendations'] as const;
  const structuredPaths = new Map(structuredFields.map(field => [field, [] as string[]]));
  const seminarPaths = content.seminars.flatMap((seminar) => {
    const bodyParts = [
      seminar.description_html ? stripLegacySeminarTail(seminar.description_html) : '',
      seminar.full_text_html ?? '',
      seminar.learning_mode ? `<h2>Как проходит обучение</h2>${seminar.learning_mode}` : '',
      seminar.learning_plan ? `<h2>Учебный план</h2>${seminar.learning_plan}` : '',
      seminar.recommendations ?? '',
    ].filter((html) => html.trim().length > 0);
    const fields = seminar.content_format === 'structured'
      ? structuredFields.filter(field => field === 'description_html' ? Boolean(seminar[field]) : Boolean(seminar[field]?.trim()))
      : [];
    if (seminar.content_format === 'structured' ? fields.length === 0 : bodyParts.length === 0) return [];

    const group = courseGroups.get(seminar.course_group_legacy_id);
    assert(group, `seminar-body ${seminar.slug}: неизвестная course_group ${seminar.course_group_legacy_id}`);
    const institute = institutes.get(group.institute_legacy_id);
    assert(institute, `seminar-body ${seminar.slug}: неизвестный institute ${group.institute_legacy_id}`);
    const route = `/${institute.slug}/${group.slug}/${seminar.slug}`;
    if (seminar.content_format === 'structured') {
      for (const field of fields) structuredPaths.get(field)!.push(route);
      return [];
    }
    return [route];
  });

  const teacherPaths = content.teachers.flatMap((teacher) => {
    if (!teacher.bio_html) return [];
    assert(teacher.institute_legacy_id, `teacher-bio ${teacher.slug}: отсутствует institute relation`);
    const institute = institutes.get(teacher.institute_legacy_id);
    assert(institute, `teacher-bio ${teacher.slug}: неизвестный institute ${teacher.institute_legacy_id}`);
    return [`/${institute.slug}/prepodavatel/${teacher.slug}`];
  });

  const replacements = new Map<string, string[]>([
    ['seminar-body', pathsAreUnique(seminarPaths, 'seminar-body')],
    ['teacher-bio', pathsAreUnique(teacherPaths, 'teacher-bio')],
    ...structuredFields.map(field => {
      const id = `seminar-${field === 'description_html' ? 'description' : field}`;
      return [id, pathsAreUnique(structuredPaths.get(field)!, id)] as [string, string[]];
    }),
  ]);
  for (const id of replacements.keys()) requiredSink(sinks, id);

  return sinks.map((sink) => {
    const paths = replacements.get(sink.id);
    return paths ? { ...sink, production: { paths, count: paths.length } } : sink;
  });
}
