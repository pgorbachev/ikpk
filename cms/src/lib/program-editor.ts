import type { Core } from '@strapi/strapi';
import { isTrustedImport } from '../seminar-management/rules.js';
import { decideProgramSlug, programEditorLabel, relationTarget } from './program-editor-label';

const COURSE_GROUP = 'api::course-group.course-group';
const INSTITUTE = 'api::institute.institute';

type Row = { id?: number; name?: string | null; slug?: string | null; editor_label?: string | null; documentId?: string; institute?: { id?: number; name?: string | null; documentId?: string } | null };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function instituteName(strapi: Core.Strapi, target: ReturnType<typeof relationTarget>): Promise<string> {
  if (!target || 'unchanged' in target || 'cleared' in target) return '';
  if ('id' in target) {
    const row = await strapi.db.query(INSTITUTE).findOne({ where: { id: target.id }, select: ['name'] }) as { name?: string | null } | null;
    return text(row?.name);
  }
  const rows = await strapi.db.query(INSTITUTE).findMany({ where: { documentId: target.documentId }, select: ['name'] }) as { name?: string | null }[];
  return text(rows.find((row) => text(row?.name))?.name);
}

async function draftProgram(strapi: Core.Strapi, documentId: string): Promise<Row | null> {
  const where = { documentId, publishedAt: { $null: true } };
  const draft = await strapi.db.query(COURSE_GROUP).findOne({
    where,
    select: ['id', 'name', 'slug', 'documentId'],
    populate: { institute: { select: ['id', 'name', 'documentId'] } },
  }) as Row | null;
  if (draft) return draft;
  return strapi.db.query(COURSE_GROUP).findOne({
    where: { documentId },
    select: ['id', 'name', 'slug', 'documentId'],
    populate: { institute: { select: ['id', 'name', 'documentId'] } },
  }) as Row | null;
}

export async function prepareProgramWrite(strapi: Core.Strapi, context: { action?: string; params?: { documentId?: string; data?: Record<string, unknown> } }): Promise<void> {
  const data = context.params?.data ?? (context.params!.data = {});
  const creating = context.action === 'create' || context.action === 'clone';
  const existing = !creating && context.params?.documentId ? await draftProgram(strapi, context.params.documentId) : null;
  const name = Object.prototype.hasOwnProperty.call(data, 'name') ? data.name : existing?.name;
  const decision = decideProgramSlug({
    name,
    existingSlug: existing?.slug ?? null,
    existingName: existing?.name ?? null,
    incomingSlug: creating && context.action === 'clone' ? null : data.slug,
    trustedImport: isTrustedImport(strapi),
    isCreate: creating,
  });
  if (decision.action === 'clear') data.slug = null;
  else if (decision.action === 'keep' || decision.action === 'incoming') data.slug = decision.slug;
  else {
    if (text(existing?.slug) && existing?.id && /^course-group(?:-\d+)?$/.test(text(existing.slug))) {
      await strapi.db.query(COURSE_GROUP).update({ where: { id: existing.id }, data: { slug: null } });
    }
    data.slug = await strapi.plugin('content-manager').service('uid').generateUIDField({
      contentTypeUID: COURSE_GROUP,
      field: 'slug',
      data: { ...data, name, id: context.params?.documentId ?? '' },
    });
  }

  let target = Object.prototype.hasOwnProperty.call(data, 'institute') ? relationTarget(data.institute) : { unchanged: true as const };
  if ('unchanged' in target) {
    target = existing?.institute?.id != null ? { id: existing.institute.id } : existing?.institute?.documentId ? { documentId: existing.institute.documentId } : { cleared: true };
  }
  const institute = 'cleared' in target ? '' : await instituteName(strapi, target);
  data.editor_label = programEditorLabel(institute, name);
}

export async function relabelInstitutePrograms(strapi: Core.Strapi, documentId: string): Promise<void> {
  const institutes = await strapi.db.query(INSTITUTE).findMany({ where: { documentId }, select: ['id', 'name'] }) as { id: number; name?: string | null }[];
  for (const institute of institutes) {
    const links = await strapi.db.connection('course_groups_institute_lnk').where({ institute_id: institute.id }).select('course_group_id') as { course_group_id: number }[];
    for (const link of links) {
      const group = await strapi.db.query(COURSE_GROUP).findOne({ where: { id: link.course_group_id }, select: ['id', 'name', 'editor_label'] }) as Row | null;
      if (!group?.id) continue;
      const label = programEditorLabel(institute.name, group.name);
      if (group.editor_label === label) continue;
      await strapi.db.connection('course_groups').where({ id: group.id }).update({ editor_label: label });
    }
  }
}

export async function backfillProgramEditorLabels(strapi: Core.Strapi): Promise<number> {
  const groups = await strapi.db.query(COURSE_GROUP).findMany({
    select: ['id', 'name', 'editor_label'],
    populate: { institute: { select: ['name'] } },
  }) as Row[];
  let updated = 0;
  for (const group of groups) {
    const label = programEditorLabel(group.institute?.name, group.name);
    if (group.editor_label === label || group.id == null) continue;
    await strapi.db.connection('course_groups').where({ id: group.id }).update({ editor_label: label });
    updated += 1;
  }
  return updated;
}

export function registerProgramEditor(strapi: Core.Strapi): void {
  strapi.documents.use(async (context, next) => {
    if (context.uid === COURSE_GROUP && (context.action === 'create' || context.action === 'update' || context.action === 'clone')) {
      await prepareProgramWrite(strapi, context);
      return next();
    }
    if (context.uid === INSTITUTE && (context.action === 'update' || context.action === 'publish') && context.params?.documentId) {
      const result = await next();
      await relabelInstitutePrograms(strapi, context.params.documentId);
      return result;
    }
    return next();
  });
}
