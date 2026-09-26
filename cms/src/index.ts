import { registerUnlinkedEntryList } from './seminar-management/available-entries';
import { ensureContentAdminRole } from './seminar-management/content-admin-role';
import { backfillAdminLabels, registerSeminarDocuments, registerSeminarUid } from './seminar-management/documents';
import { applyEditorForms } from './seminar-management/forms';

export default {
  register({ strapi }) {
    registerSeminarUid(strapi);
    registerSeminarDocuments(strapi);
    registerUnlinkedEntryList(strapi);
  },

  async bootstrap({ strapi }) {
    await applyEditorForms(strapi);
    await backfillAdminLabels(strapi);
    await ensureContentAdminRole(strapi);
  },
};
