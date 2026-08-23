import type { Core } from '@strapi/strapi';

/**
 * Ограничения загрузки медиа (D5 в design.md change `cms-content-authoring-and-migration`).
 *
 * Векторная графика не принимается: файл, отдаваемый с адреса сайта, исполняется в его
 * источнике, а SVG — это разметка, а не растровое изображение. Значения читает
 * `src/index.ts` (`register`), чтобы enforcement и конфигурация не расходились.
 */
export const UPLOAD_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const config = (): Core.Config.Plugin => ({
  upload: {
    config: {
      sizeLimit: UPLOAD_SIZE_LIMIT_BYTES,
      allowedTypes: UPLOAD_ALLOWED_MIME_TYPES,
    },
  },
});

export default config;
