import { registerUnlinkedEntryList } from './seminar-management/available-entries';
import { ensureCaptureToken } from './seminar-management/capture-token';
import { ensureContentAdminRole } from './seminar-management/content-admin-role';
import { backfillAdminLabels, registerSeminarDocuments, registerSeminarUid } from './seminar-management/documents';
import { applyEditorForms } from './seminar-management/forms';
import { registerSiteRefresh } from './seminar-management/site-refresh';

export default {
  register({ strapi }) {
    registerSeminarUid(strapi);
    registerSeminarDocuments(strapi);
    registerUnlinkedEntryList(strapi);
    registerSiteRefresh(strapi);
  },

  async bootstrap({ strapi }) {
    await applyEditorForms(strapi);
    await backfillAdminLabels(strapi);
    await ensureContentAdminRole(strapi);
    await ensureCaptureToken(strapi);
  },
};
