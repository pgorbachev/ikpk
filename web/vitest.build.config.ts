import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/article-catalog.test.ts',
      'tests/perf-a11y.test.ts',
      'tests/parity-compare.test.ts',
      'tests/media-migration.test.ts',
      'tests/content-quality.test.ts',
      'tests/seo-package.test.ts',
      'tests/schedule-month-dist.test.ts',
    ],
  },
});
