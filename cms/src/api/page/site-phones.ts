import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { checkPagePhones, PHONE_FIELDS, type PhoneField } from '../../lib/site-phones';

type Phones = Record<PhoneField, string | null>;
type PageRow = Phones & {
  id: number;
  document_id: string;
  slug: string;
  legacy_id: string;
  published_at: string | null;
  updated_at: string | number | Date | null;
};

function phonePair({ center_phone, manager_phone }: Phones): Phones {
  return { center_phone, manager_phone };
}

function view(draftRow: PageRow, publishedRow: PageRow) {
  const draft = phonePair(draftRow);
  const published = phonePair(publishedRow);
  const revision = createHash('sha256')
    .update(JSON.stringify([draftRow.id, publishedRow.id, draft, published]))
    .digest('hex');
  return { draft, published, revision };
}

// Strapi copies SEO components into a new row on publish. Their row IDs differ even
// when their content (including the linked social image) is identical.
async function hasOtherDraftChanges(strapi, draft: PageRow, published: PageRow) {
  const rows = await strapi.db.query('api::page.page').findMany({
    where: { id: { $in: [draft.id, published.id] } },
    select: ['title', 'body'],
    populate: { seo: { populate: { og_image: { select: ['id'] } } } },
  });
  const [first, second] = rows.map(({ title, body, seo }) => ({
    title, body, seo: seo && { ...seo, id: undefined },
  }));
  return !isDeepStrictEqual(first, second);
}

export function registerSitePhones(strapi) {
  const routes = strapi.admin.routes.admin.routes;
  for (const [method, path, action] of [
    ['GET', '/site-phones', 'read'],
    ['PUT', '/site-phones/draft', 'save'],
    ['POST', '/site-phones/publish', 'publish'],
  ]) {
    routes.push({
      method, path,
      config: { policies: ['admin::isAuthenticatedAdmin'] },
      handler: async (ctx) => {
        const actor = ctx.state.user;
        if (!actor.roles.some(({ code }) => code === 'content-admin' || code === 'strapi-super-admin')) {
          return ctx.forbidden('Недостаточно прав для изменения телефонов сайта.');
        }
        if (Object.keys(ctx.query).length) return ctx.badRequest('Страницу контактов выбирает сервер.');
        const writing = action !== 'read';
        const changes = writing ? ctx.request.body : {};
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
            Object.entries(changes).some(([key, value]) => !PHONE_FIELDS.includes(key as PhoneField) ||
              (value !== null && (typeof value !== 'string' || value.length > 255)))) {
          return ctx.badRequest('Можно передать только строковые поля center_phone и manager_phone.');
        }

        try {
          await strapi.db.transaction(async ({ trx }) => {
            const query = trx('pages').select('id', 'document_id', 'slug', 'legacy_id', 'published_at', 'updated_at', ...PHONE_FIELDS)
              .where('slug', 'kontakty').orWhere('legacy_id', 'kontakty').orderBy('id');
            const rows: PageRow[] = await (writing ? query.forUpdate() : query);
            const draft = rows.find((row) => row.published_at === null);
            const published = rows.find((row) => row.published_at !== null);
            if (rows.length !== 2 || !draft || !published || draft.document_id !== published.document_id ||
                rows.some((row) => row.slug !== 'kontakty' || row.legacy_id !== 'kontakty')) {
              return ctx.conflict('Для /kontakty нужны одна опубликованная версия и один черновик одной страницы.');
            }
            const current = view(draft, published);
            if (!writing) {
              ctx.body = current;
              return;
            }
            if (ctx.get('If-Match') !== `"${current.revision}"`) {
              return ctx.conflict('Телефоны уже изменились. Откройте актуальные значения и повторите правку.');
            }
            if (action === 'publish' && !Object.keys(changes).length) {
              return ctx.badRequest('Выберите хотя бы один телефон для публикации.');
            }
            const nextDraft = { ...current.draft, ...changes };
            const nextPublished = action === 'publish' ? { ...current.published, ...changes } : current.published;
            if (action === 'publish') {
              const error = checkPagePhones('kontakty', nextPublished, true);
              if (error) return ctx.badRequest(error.message);
            }
            const draftChanged = !isDeepStrictEqual(current.draft, nextDraft);
            const publishedChanged = !isDeepStrictEqual(current.published, nextPublished);
            if (!draftChanged && !publishedChanged) {
              ctx.body = current;
              return;
            }

            // Content Manager marks the document modified exactly when draft.updatedAt
            // is later than published.updatedAt. Keep that ordering for outstanding
            // phones and editorial changes without replacing either version.
            const pending = !isDeepStrictEqual(nextDraft, nextPublished)
              || await hasOtherDraftChanges(strapi, draft, published);
            const previousPublication = new Date(published.updated_at ?? 0).getTime();
            const now = Math.max(Date.now(), previousPublication + 1);
            const publishedTime = publishedChanged ? now : previousPublication;
            const draftTime = pending ? Math.max(now, publishedTime + 1) : publishedTime;

            if (publishedChanged) {
              await trx('pages').where({ id: published.id }).update({
                ...changes, updated_at: new Date(publishedTime), updated_by_id: actor.id,
              });
            }
            await trx('pages').where({ id: draft.id }).update({
              ...changes, updated_at: new Date(draftTime),
              ...(draftChanged ? { updated_by_id: actor.id } : {}),
            });
            ctx.body = view({ ...draft, ...changes }, { ...published, ...nextPublished });
          });
        } catch (error) {
          if (String(error?.code).startsWith('SQLITE_BUSY')) {
            return ctx.conflict('Контакты сейчас меняются. Откройте актуальные значения и повторите правку.');
          }
          throw error;
        }
      },
    });
  }
}
