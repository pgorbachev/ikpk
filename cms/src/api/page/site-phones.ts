import { createHash } from 'node:crypto';
import { checkPagePhones, PHONE_FIELDS, type PhoneField } from '../../lib/site-phones';

type Phones = Record<PhoneField, string | null>;
type PageRow = Phones & {
  id: number;
  document_id: string;
  slug: string;
  legacy_id: string;
  published_at: string | null;
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
        const actor = await strapi.db.query('admin::user').findOne({
          where: { id: ctx.state.user.id }, populate: ['roles'],
        });
        if (!actor?.roles.some(({ code }) => code === 'content-admin' || code === 'strapi-super-admin')) {
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
            const query = trx('pages').select('id', 'document_id', 'slug', 'legacy_id', 'published_at', ...PHONE_FIELDS)
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
            const next = { ...current.draft, ...changes };
            if (action === 'publish') {
              const error = checkPagePhones('kontakty', next, true);
              if (error) return ctx.badRequest(error.message);
              await trx('pages').where({ id: published.id }).update(next);
              Object.assign(published, next);
            }
            if (Object.keys(changes).length) await trx('pages').where({ id: draft.id }).update(changes);
            ctx.body = view({ ...draft, ...changes }, published);
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
