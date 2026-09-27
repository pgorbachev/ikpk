import { AsyncLocalStorage } from 'node:async_hooks';
import { SCHEDULE_ENTRY_UID, SEMINAR_UID } from './rules.js';

const unlinkedOnly = new AsyncLocalStorage();

function restrictToUnlinked(event) {
  if (unlinkedOnly.getStore() !== true) return;
  const params = event.params ?? {};
  event.params = params;
  const clause = { seminar: { $null: true } };
  params.where = params.where ? { $and: [params.where, clause] } : clause;
}

/** Список выбора в карточке семинара показывает только проведения без семинара. */
export function registerUnlinkedEntryList(strapi) {
  const relations = strapi.plugin('content-manager').controller('relations');
  const original = relations.findAvailable.bind(relations);
  relations.findAvailable = (ctx) => {
    const model = ctx.params?.model;
    const targetField = ctx.params?.targetField;
    if (model === SEMINAR_UID && targetField === 'schedule_entries') {
      return unlinkedOnly.run(true, () => original(ctx));
    }
    return original(ctx);
  };

  strapi.db.lifecycles.subscribe({
    models: [SCHEDULE_ENTRY_UID],
    beforeFindMany: restrictToUnlinked,
    beforeCount: restrictToUnlinked,
  });
}
