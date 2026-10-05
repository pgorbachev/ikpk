import type { Core } from '@strapi/strapi';

/**
 * Ограничения загрузки медиа (D5 в design.md change `cms-content-authoring-and-migration`).
 *
 * Векторная графика не принимается: файл, отдаваемый с адреса сайта, исполняется в его
 * источнике, а SVG — это разметка, а не растровое изображение. Значения читает
 * `src/index.ts` (`register`), чтобы enforcement и конфигурация не расходились.
 *
 * `security.allowedTypes` — не `upload.config.allowedTypes` верхнего уровня: последний не
 * является распознаваемым ключом ядра `@strapi/upload` (валидатор конфига плагина проверяет
 * только `concurrentUploadSize`/`concurrentUploadRequests` и молча пропускает остальное —
 * см. `node_modules/@strapi/upload/dist/server/config.js`). Реальный gate по MIME —
 * `mime-validation.js` (`prepareUploadRequest` → `enforceUploadSecurity` → `validateFiles`),
 * который читает именно `plugin::upload.security.allowedTypes`/`deniedTypes` и вызывается
 * контроллерами (`admin-upload.js`, `content-api.js`) ДО `uploadService.upload()`, то есть до
 * физической записи байтов на диск — в отличие от хука в `src/index.ts`, который срабатывает
 * уже после неё.
 */
export const UPLOAD_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const config = (): Core.Config.Plugin => ({
  upload: {
    config: {
      sizeLimit: UPLOAD_SIZE_LIMIT_BYTES,
      security: {
        allowedTypes: UPLOAD_ALLOWED_MIME_TYPES,
      },
    },
  },
});

export default config;
