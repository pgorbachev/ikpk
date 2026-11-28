const FIELD = 'student_document_form_url';
const VALUE = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/?telemetry_sign=v1%3A6%3Adirect_link.2b373ae14476af8c466795c40598e242f26f55b15de21454f4c9dcb4d5acb8c4';

export function apply(db, { onApplied } = {}) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, document_id, slug, legacy_id, published_at, ${FIELD} AS value FROM pages
      WHERE document_id IN (SELECT document_id FROM pages WHERE slug='oplata' OR legacy_id='oplata')
      OR slug='oplata' OR legacy_id='oplata' ORDER BY id`).all();
    if (rows.length !== 2 || new Set(rows.map(row => row.document_id)).size !== 1 || !rows[0].document_id
        || rows.filter(row => row.published_at !== null).length !== 1
        || rows.some(row => row.slug !== 'oplata' || row.legacy_id !== 'oplata')) {
      throw new Error('Cannot seed student document form: Page /oplata requires exactly one published version and one matching draft');
    }
    const update = db.prepare(`UPDATE pages SET ${FIELD}=? WHERE id=? AND ${FIELD} IS NULL`);
    let updatedRows = 0;
    for (const row of rows) if (row.value == null) updatedRows += update.run(VALUE, row.id).changes;
    const result = { updatedRows };
    onApplied?.(db, result);
    return result;
  }).immediate();
}

export { FIELD, VALUE };
