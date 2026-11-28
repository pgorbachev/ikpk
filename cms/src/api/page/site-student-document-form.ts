import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { STUDENT_DOCUMENT_FORM_DEFAULT, STUDENT_DOCUMENT_FORM_FIELD, validateStudentDocumentFormUrl } from '../../lib/student-document-form';

type PageRow = { id: number; document_id: string; slug: string; legacy_id: string; published_at: string | null; updated_at: string | number | Date | null; student_document_form_url: string | null };
const ROLES = ['strapi-editor', 'content-admin', 'strapi-super-admin'];

function revision(draft: PageRow, published: PageRow) {
  const time = (value: PageRow['updated_at']) => value instanceof Date ? value.getTime() : Number.isFinite(Number(value)) ? Number(value) : new Date(value ?? 0).getTime();
  return createHash('sha256').update(JSON.stringify([draft.id, time(draft.updated_at), draft.student_document_form_url, published.id, time(published.updated_at), published.student_document_form_url])).digest('hex');
}

async function hasOtherDraftChanges(strapi, draft: PageRow, published: PageRow) {
  const rows = await strapi.db.query('api::page.page').findMany({
    where: { id: { $in: [draft.id, published.id] } },
    select: ['title', 'slug', 'legacy_id', 'body', 'center_phone', 'manager_phone'],
    populate: { seo: { populate: { og_image: { select: ['id'] } } } },
  });
  const valuesFor = (row: Record<string, any> | undefined) => row && ({
    title: row.title, slug: row.slug, legacy_id: row.legacy_id, body: row.body,
    center_phone: row.center_phone, manager_phone: row.manager_phone,
    seo: row.seo ? { seo_title: row.seo.seo_title, seo_description: row.seo.seo_description,
      noindex: row.seo.noindex, og_image: row.seo.og_image?.id ?? null } : null,
  });
  const draftValue = valuesFor(rows.find(row => row.id === draft.id));
  const publishedValue = valuesFor(rows.find(row => row.id === published.id));
  return !draftValue || !publishedValue || !isDeepStrictEqual(draftValue, publishedValue);
}

async function actorMayEdit(strapi, user) {
  if (!user?.id) return false;
  const stored = await strapi.db.query('admin::user').findOne({ where: { id: user.id }, populate: ['roles'] });
  return (stored?.roles ?? []).some(({ code }) => ROLES.includes(code));
}

export function registerSiteStudentDocumentForm(strapi) {
  const routes = strapi.admin?.routes?.admin?.routes;
  if (!Array.isArray(routes)) return;
  for (const [method, path, action] of [
    ['GET', '/site-student-document-form', 'read'],
    ['PUT', '/site-student-document-form/draft', 'save'],
    ['POST', '/site-student-document-form/publish', 'publish'],
  ]) routes.push({ method, path, config: { policies: ['admin::isAuthenticatedAdmin'] }, handler: async (ctx) => {
    if (!(await actorMayEdit(strapi, ctx.state.user))) return ctx.forbidden('Недостаточно прав для изменения ссылки формы документов.');
    if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest('Страницу «Оплата» выбирает сервер.');
    const body = action === 'read' ? {} : ctx.request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== STUDENT_DOCUMENT_FORM_FIELD)
        || (action !== 'read' && Object.keys(body).length !== 1)) return ctx.badRequest(`Можно передать только поле ${STUDENT_DOCUMENT_FORM_FIELD}.`);
    if (action !== 'read') {
      const error = validateStudentDocumentFormUrl(body[STUDENT_DOCUMENT_FORM_FIELD]);
      if (error) return ctx.badRequest(error);
    }
    try {
      await strapi.db.transaction(async ({ trx }) => {
        const query = trx('pages').select('id', 'document_id', 'slug', 'legacy_id', 'published_at', 'updated_at', STUDENT_DOCUMENT_FORM_FIELD)
          .where('slug', 'oplata').orWhere('legacy_id', 'oplata').orderBy('id');
        const rows: PageRow[] = await (action === 'read' ? query : query.forUpdate());
        const draft = rows.find(row => row.published_at === null), published = rows.find(row => row.published_at !== null);
        if (rows.length !== 2 || !draft || !published || !draft.document_id || draft.document_id !== published.document_id
            || rows.some(row => row.slug !== 'oplata' || row.legacy_id !== 'oplata')) return ctx.conflict('Для страницы оплаты нужны опубликованная версия и черновик одной Page.');
        const currentRevision = revision(draft, published);
        if (action === 'read') { ctx.body = { draft: draft.student_document_form_url ?? '', published: published.student_document_form_url ?? '', revision: currentRevision }; return; }
        if (ctx.get('If-Match') !== `"${currentRevision}"`) return ctx.conflict('Адрес уже изменился. Загрузите актуальное значение и повторите правку.');
        const value = body[STUDENT_DOCUMENT_FORM_FIELD] as string;
        const previousDraft = draft.student_document_form_url ?? '', previousPublished = published.student_document_form_url ?? '';
        const draftChanged = value !== previousDraft;
        const publishedChanged = action === 'publish' && value !== previousPublished;
        if (!draftChanged && !publishedChanged) {
          ctx.body = { draft: previousDraft, published: previousPublished, revision: currentRevision };
          return;
        }
        const pending = action === 'publish' && await hasOtherDraftChanges(strapi, draft, published);
        const previousPublication = new Date(published.updated_at ?? 0).getTime();
        const now = Math.max(Date.now(), previousPublication + 1);
        const publishedTime = publishedChanged ? now : previousPublication;
        const draftTime = action === 'publish'
          ? pending ? Math.max(now, publishedTime + 1, new Date(draft.updated_at ?? 0).getTime() + 1) : publishedTime
          : Math.max(now, new Date(draft.updated_at ?? 0).getTime() + 1);
        if (publishedChanged) await trx('pages').where({ id: published.id }).update({ [STUDENT_DOCUMENT_FORM_FIELD]: value, updated_at: new Date(publishedTime), updated_by_id: ctx.state.user.id });
        await trx('pages').where({ id: draft.id }).update({ [STUDENT_DOCUMENT_FORM_FIELD]: value, updated_at: new Date(draftTime), updated_by_id: ctx.state.user.id });
        const updatedDraft = { ...draft, student_document_form_url: value, updated_at: new Date(draftTime) };
        const updatedPublished = { ...published, ...(publishedChanged ? { student_document_form_url: value, updated_at: new Date(publishedTime) } : {}) };
        ctx.body = { draft: value, published: updatedPublished.student_document_form_url ?? '', revision: revision(updatedDraft, updatedPublished) };
      });
    } catch (cause) {
      if (String(cause?.code).startsWith('SQLITE_BUSY')) return ctx.conflict('Страница оплаты сейчас меняется. Загрузите актуальное значение и повторите правку.');
      throw cause;
    }
  }});
}

export { STUDENT_DOCUMENT_FORM_DEFAULT };
