import type { Core } from '@strapi/strapi';
import { UPLOAD_ALLOWED_EXTENSIONS, UPLOAD_ALLOWED_MIME_TYPES, UPLOAD_SIZE_LIMIT_BYTES } from '../config/plugins';
import { registerEditorCardRestrictions, syncEditorRolePermissions, type EditorRoleStrapi } from './lib/editor-role';
import { assertStoredUploadExtension, registerUploadExtensionGuard } from './lib/upload-extension';
import { registerContentAddressLifecycle } from './lifecycles/content-address';
import { registerPublicationLifecycle } from './lifecycles/publication';
import { registerUnlinkedEntryList } from './seminar-management/available-entries';
import { bootstrapCaptureTokenForRehearsal } from './seminar-management/capture-token';
import { ensureContentAdminRole, migrateContentAdminSchemaPermissions } from './seminar-management/content-admin-role';
import { backfillAdminLabels, registerSeminarDocuments, registerSeminarUid } from './seminar-management/documents';
import { backfillProgramEditorLabels, registerProgramEditor } from './lib/program-editor';
import { applyEditorForms } from './seminar-management/forms';
import { registerSitePhones } from './api/page/site-phones';
import { registerSiteBooks } from './api/page/site-books';
import { registerSiteStudentDocumentForm } from './api/page/site-student-document-form';
import { registerSiteRefresh } from './seminar-management/site-refresh';

export default {
  register({ strapi }) {
    strapi.customFields.register({ name: 'wall-clock-datetime', type: 'datetime' });
    strapi.customFields.register({ name: 'occurrence-city', type: 'string' });
    strapi.customFields.register({ name: 'occurrence-price', type: 'decimal' });
    strapi.customFields.register({ name: 'occurrence-duration', type: 'string' });
    registerSeminarUid(strapi);
    registerEditorCardRestrictions(strapi);
    registerProgramEditor(strapi);
    registerSeminarDocuments(strapi);
    registerUnlinkedEntryList(strapi);
    registerSiteRefresh(strapi);
    registerSitePhones(strapi);
    registerSiteBooks(strapi);
    registerSiteStudentDocumentForm(strapi);
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
   *
   * Расширение имени — отдельный список `UPLOAD_ALLOWED_EXTENSIONS`.
   * `registerUploadExtensionGuard` оборачивает `upload` и `replace` (admin `/upload`,
   * `/api/upload` и замена `?id=`) и отклоняет имя до `uploadFileAndPersist`. Этот хук —
   * вторая линия для того же списка: прямая запись в БД происходит уже после провайдера.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    registerUploadExtensionGuard(strapi, UPLOAD_ALLOWED_EXTENSIONS);
    strapi.db.lifecycles.subscribe({
      models: ['plugin::upload.file'],
      beforeCreate(event) {
        const { mime, size, name, ext } = (event.params.data ?? {}) as {
          mime?: string;
          size?: number;
          name?: unknown;
          ext?: unknown;
        };
        if (mime && !(UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
          throw new Error(`недопустимый формат файла: ${mime}`);
        }
        if (typeof size === 'number' && size * 1024 > UPLOAD_SIZE_LIMIT_BYTES) {
          throw new Error(`файл превышает предел размера загрузки: ${size} КБ`);
        }
        assertStoredUploadExtension({ mime, name, ext }, UPLOAD_ALLOWED_EXTENSIONS);
      },
    });

    registerContentAddressLifecycle(strapi);
    registerPublicationLifecycle(strapi);
    await syncEditorRolePermissions(strapi as unknown as EditorRoleStrapi);

    await applyEditorForms(strapi);
    await backfillAdminLabels(strapi);
    await backfillProgramEditorLabels(strapi);
    await ensureContentAdminRole(strapi);
    await migrateContentAdminSchemaPermissions(strapi, {
      additions: {
        'api::course-group.course-group': ['editor_label'],
        'api::seminar.seminar': ['seo.og_title', 'seo.og_description'],
      },
    });
    await bootstrapCaptureTokenForRehearsal(
      strapi as unknown as Parameters<typeof bootstrapCaptureTokenForRehearsal>[0],
    );
  },
};
