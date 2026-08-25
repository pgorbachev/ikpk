import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(webRoot, '..');

export default defineConfig({
  server: {
    fs: { allow: [webRoot, repoRoot] },
  },
  test: {
    setupFiles: ['tests/helpers/ensure-tsx-root.ts'],
    testTimeout: 20_000,
    include: ['tests/**/*.test.ts'],
    exclude: [
      // dist-зависимые тесты — только в vitest.build.config.ts (после сборки)
      'tests/article-catalog.test.ts',
      'tests/perf-a11y.test.ts',
      'tests/parity-compare.test.ts',
      'tests/media-migration.test.ts',
      'tests/content-quality.test.ts',
      'tests/seo-package.test.ts',
      'tests/payment-characterization.test.ts',
      'tests/payment-form-dist.test.ts',
      'tests/payment-role-dist.test.ts',
      'tests/site-copy.test.ts',
      'tests/social-accounts-ci-dist.test.ts',
      // Предмет — вывод сборки РОЛИ `stand`, конфигурация vitest.stand.config.ts
      // (запускается через npm run test:stand, который его сначала собирает).
      'tests/social-accounts-stand-dist.test.ts',
      // Предмет — вывод ДЕМО-сборки, конфигурация vitest.demo.config.ts
      // (запускается через npm run test:demo, который его сначала собирает).
      'tests/demo-output.test.ts',
      'tests/demo-prototypes.test.ts',
      'tests/demo-payment-form.test.ts',
      'tests/preview-role-dist.test.ts',
      'tests/social-accounts-preview-dist.test.ts',
      'tests/rich-content-canary.demo.test.ts',
      'tests/rich-content-hazard.demo.test.ts',
      'tests/schedule-month-dist.test.ts',
      'tests/rich-content-canary.build.test.ts',
      'tests/rich-content-hazard.build.test.ts',
      'tests/rich-content-migration.build.test.ts',
      // Рендер компонента через Astro Container API — отдельная конфигурация
      // (vitest.render.config.ts), потому что `.astro` требует vite-плагина Astro.
      'tests/schedule-filters.render.test.ts',
      'tests/rich-content-render.test.ts',
    ],
  },
});
