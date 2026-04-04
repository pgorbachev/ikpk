import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/perf-a11y.test.ts',
      'tests/parity-compare.test.ts',
    ],
  },
});
