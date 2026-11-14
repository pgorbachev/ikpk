// Runs only in a closed Strapi lifecycle; the callback writes the runner
// ledger through the same Knex transaction as the permission changes.
export async function apply(strapi, options) {
  const { migrateContentAdminSchemaPermissions } = await import('../../../dist/src/seminar-management/content-admin-role.js');
  if (typeof migrateContentAdminSchemaPermissions !== 'function') throw new Error('content-admin migration export is missing');
  return migrateContentAdminSchemaPermissions(strapi, options);
}
