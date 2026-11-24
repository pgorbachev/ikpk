// The runner records the step in the same transaction as both physical versions.
export function apply(db, { onApplied } = {}) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id, document_id, slug, legacy_id, published_at, center_phone, manager_phone
      FROM pages WHERE document_id IN
        (SELECT document_id FROM pages WHERE slug = 'kontakty' OR legacy_id = 'kontakty')
        OR slug = 'kontakty' OR legacy_id = 'kontakty'`).all();
    if (rows.length !== 2 || new Set(rows.map(row => row.document_id)).size !== 1
        || rows.filter(row => row.published_at !== null).length !== 1
        || rows.some(row => !row.document_id || row.slug !== 'kontakty' || row.legacy_id !== 'kontakty')) {
      throw new Error('Cannot seed phones: Page /kontakty requires exactly one published version and one matching draft');
    }
    const update = db.prepare(`UPDATE pages SET center_phone = COALESCE(center_phone, ?),
      manager_phone = COALESCE(manager_phone, ?) WHERE id = ? AND (center_phone IS NULL OR manager_phone IS NULL)`);
    let updatedRows = 0;
    for (const row of rows) {
      updatedRows += update.run('+7 (812) 646-54-50', '+7 981 038-77-97', row.id).changes;
    }
    const result = { updatedRows };
    onApplied?.(db, result);
    return result;
  }).immediate();
}
