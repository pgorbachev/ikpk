import type { Core } from '@strapi/strapi';
import { UPLOAD_ALLOWED_MIME_TYPES, UPLOAD_SIZE_LIMIT_BYTES } from '../config/plugins';
import { syncEditorRolePermissions, type EditorRoleStrapi } from './lib/editor-role';
import { registerContentAddressLifecycle } from './lifecycles/content-address';
import { registerPublicationLifecycle } from './lifecycles/publication';
import { registerUnlinkedEntryList } from './seminar-management/available-entries';
import { ensureCaptureToken } from './seminar-management/capture-token';
import { ensureContentAdminRole } from './seminar-management/content-admin-role';
import { backfillAdminLabels, registerSeminarDocuments, registerSeminarUid } from './seminar-management/documents';
import { applyEditorForms } from './seminar-management/forms';
import { registerSiteRefresh } from './seminar-management/site-refresh';

export default {
  register({ strapi }) {
    strapi.customFields.register({ name: 'wall-clock-datetime', type: 'datetime' });
    registerSeminarUid(strapi);
    registerSeminarDocuments(strapi);
    registerUnlinkedEntryList(strapi);
    registerSiteRefresh(strapi);
  },

  /**
   * Вторая линия для ограничений D5 (`cms/config/plugins.ts`): реальный gate по MIME —
   * `plugin::upload.security.allowedTypes` (см. комментарий там же), он останавливает запись
   * ДО physical write и покрывает и admin, и `/api/upload`. Этот хук на `plugin::upload.file`
   * срабатывает на `strapi.db.query(...).create()`, то есть уже ПОСЛЕ того, как провайдер
   * записал байты на диск (`uploadFileAndPersist()` в `@strapi/upload` вызывает
   * `provider.upload()` раньше, чем `add()`/`create()`) — он не останавливает саму запись
   * файла, а ловит запись в БД в обход контроллеров (например, прямой `db.query(...).create()`
   * из скрипта или другого плагина).
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.db.lifecycles.subscribe({
      models: ['plugin::upload.file'],
      beforeCreate(event) {
        const { mime, size } = (event.params.data ?? {}) as { mime?: string; size?: number };
        if (mime && !(UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
          throw new Error(`недопустимый формат файла: ${mime}`);
        }
        if (typeof size === 'number' && size * 1024 > UPLOAD_SIZE_LIMIT_BYTES) {
          throw new Error(`файл превышает предел размера загрузки: ${size} КБ`);
        }
      },
    });

    registerContentAddressLifecycle(strapi);
    registerPublicationLifecycle(strapi);
    await syncEditorRolePermissions(strapi as unknown as EditorRoleStrapi);

    await applyEditorForms(strapi);
    await backfillAdminLabels(strapi);
    await ensureContentAdminRole(strapi);
    await ensureCaptureToken(strapi as unknown as Parameters<typeof ensureCaptureToken>[0]);
  },
};
