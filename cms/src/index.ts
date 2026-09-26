import { applyEditorForms } from './seminar-management/forms';
import { ensureContentAdminRole } from './seminar-management/content-admin-role';
import { registerSeminarDocuments, registerSeminarUid } from './seminar-management/documents';

export default {
  register({ strapi }) {
    registerSeminarUid(strapi);
    registerSeminarDocuments(strapi);
  },

  async bootstrap({ strapi }) {
    await applyEditorForms(strapi);
    await ensureContentAdminRole(strapi);
  },
};
