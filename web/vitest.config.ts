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
      'tests/payment-characterization.test.ts',
      'tests/payment-form-dist.test.ts',
      // Предмет — вывод ДЕМО-сборки, конфигурация vitest.demo.config.ts
      // (запускается через npm run test:demo, который его сначала собирает).
      'tests/demo-output.test.ts',
      'tests/demo-prototypes.test.ts',
      'tests/demo-payment-form.test.ts',
    ],
  },
});
