import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      // dist-зависимые тесты — только в vitest.build.config.ts (после сборки)
      'tests/article-catalog.test.ts',
      'tests/perf-a11y.test.ts',
      'tests/parity-compare.test.ts',
      'tests/media-migration.test.ts',
      'tests/content-quality.test.ts',
      'tests/seo-package.test.ts',
      // Предмет — вывод ДЕМО-сборки, конфигурация vitest.demo.config.ts
      // (запускается через npm run test:demo, который его сначала собирает).
      'tests/demo-output.test.ts',
      'tests/demo-prototypes.test.ts',
      'tests/rich-content-canary.demo.test.ts',
      'tests/rich-content-hazard.demo.test.ts',
      'tests/schedule-month-dist.test.ts',
      'tests/rich-content-canary.build.test.ts',
      'tests/rich-content-hazard.build.test.ts',
      // Рендер компонента через Astro Container API — отдельная конфигурация
      // (vitest.render.config.ts), потому что `.astro` требует vite-плагина Astro.
      'tests/schedule-filters.render.test.ts',
      'tests/rich-content-render.test.ts',
    ],
  },
});
