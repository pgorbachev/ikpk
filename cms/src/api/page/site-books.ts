import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BOOK_PAGE_SLUG, checkBookIntroduction } from '../../lib/book-seller';

type PageRow = {
  id: number;
  document_id: string;
  slug: string;
  legacy_id: string;
  body: string | null;
  title?: string | null;
  published_at: string | null;
  updated_at: string | number | Date | null;
  center_phone?: string | null;
  manager_phone?: string | null;
  seo?: { seo_title?: string | null; seo_description?: string | null; noindex?: boolean | null; og_image?: { id?: number } | null } | null;
};

function version(draft: PageRow, published: PageRow) {
  const time = (value: PageRow['updated_at']) => value instanceof Date ? value.getTime()
    : Number.isFinite(Number(value)) ? Number(value) : new Date(value ?? 0).getTime();
  const revision = createHash('sha256').update(JSON.stringify([
    draft.id, time(draft.updated_at), draft.body, published.id, time(published.updated_at), published.body,
  ])).digest('hex');
  return { draft: draft.body ?? '', published: published.body ?? '', revision };
}

async function hasOtherDraftChanges(strapi, draft: PageRow, published: PageRow) {
  const rows = await strapi.db.query('api::page.page').findMany({
    where: { id: { $in: [draft.id, published.id] } },
    select: ['title', 'slug', 'legacy_id', 'center_phone', 'manager_phone'],
    populate: { seo: { populate: { og_image: { select: ['id'] } } } },
  });
  const [first, second] = rows.map((row) => ({
    title: row.title,
    slug: row.slug,
    legacy_id: row.legacy_id,
    center_phone: row.center_phone,
    manager_phone: row.manager_phone,
    seo: row.seo ? {
      seo_title: row.seo.seo_title,
      seo_description: row.seo.seo_description,
      noindex: row.seo.noindex,
      og_image: row.seo.og_image?.id ?? null,
    } : null,
  }));
  return !isDeepStrictEqual(first, second);
}

async function actorMayEdit(strapi, user) {
  if (!user?.id) return false;
  const stored = await strapi.db.query('admin::user').findOne({
    where: { id: user.id },
    populate: ['roles'],
  });
  return (stored?.roles ?? []).some(({ code }) => ['strapi-editor', 'content-admin', 'strapi-super-admin'].includes(code));
}

export function registerSiteBooks(strapi) {
  const routes = strapi.admin?.routes?.admin?.routes;
  if (!Array.isArray(routes)) return;
  for (const [method, path, action] of [
    ['GET', '/site-books', 'read'],
    ['PUT', '/site-books/draft', 'save'],
    ['POST', '/site-books/publish', 'publish'],
  ]) {
    routes.push({
      method, path,
      config: { policies: ['admin::isAuthenticatedAdmin'] },
      handler: async (ctx) => {
        if (!(await actorMayEdit(strapi, ctx.state.user))) return ctx.forbidden('Недостаточно прав для изменения вводного текста книг.');
        if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest('Страницу книг выбирает сервер.');
        const body = action === 'read' ? {} : ctx.request.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some((key) => key !== 'body')
            || (action !== 'read' && Object.keys(body).length !== 1)) {
          return ctx.badRequest('Можно передать только поле body страницы книг.');
        }
        const error = action === 'read' ? null : checkBookIntroduction(body.body);
        if (error) return ctx.badRequest(error);
        try {
          await strapi.db.transaction(async ({ trx }) => {
            const query = trx('pages').select('id', 'document_id', 'slug', 'legacy_id', 'body', 'published_at', 'updated_at')
              .where('slug', BOOK_PAGE_SLUG).orWhere('legacy_id', BOOK_PAGE_SLUG).orderBy('id');
            const rows: PageRow[] = await (action === 'read' ? query : query.forUpdate());
            const draft = rows.find((row) => row.published_at === null);
            const published = rows.find((row) => row.published_at !== null);
            if (rows.length !== 2 || !draft || !published || !draft.document_id
                || draft.document_id !== published.document_id
                || rows.some((row) => row.slug !== BOOK_PAGE_SLUG || row.legacy_id !== BOOK_PAGE_SLUG)) {
              return ctx.conflict('Для страницы книг нужны одна опубликованная версия и один черновик одной Page.');
            }
            const current = version(draft, published);
            if (action === 'read') {
              ctx.body = current;
              return;
            }
            if (ctx.get('If-Match') !== `"${current.revision}"`) {
              return ctx.conflict('Текст уже изменился. Загрузите актуальные значения и повторите правку.');
            }
            const text = body.body as string;
            const pending = await hasOtherDraftChanges(strapi, draft, published);
            const previousPublication = new Date(published.updated_at ?? 0).getTime();
            const now = Math.max(Date.now(), previousPublication + 1);
            const publishedTime = action === 'publish' ? new Date(now) : published.updated_at;
            const draftTime = action === 'publish'
              ? new Date(pending ? Math.max(now, new Date(publishedTime).getTime() + 1) : now)
              : new Date(Math.max(now, new Date(draft.updated_at ?? 0).getTime() + 1));
            if (action === 'publish') await trx('pages').where({ id: published.id }).update({ body: text, updated_at: publishedTime, updated_by_id: ctx.state.user.id });
            await trx('pages').where({ id: draft.id }).update({ body: text, updated_at: draftTime, updated_by_id: ctx.state.user.id });
            ctx.body = version({ ...draft, body: text, updated_at: draftTime }, {
              ...published, ...(action === 'publish' ? { body: text, updated_at: publishedTime } : {}),
            });
          });
        } catch (cause) {
          if (String(cause?.code).startsWith('SQLITE_BUSY')) return ctx.conflict('Текст сейчас меняется. Загрузите актуальные значения и повторите правку.');
          throw cause;
        }
      },
    });
  }
}
