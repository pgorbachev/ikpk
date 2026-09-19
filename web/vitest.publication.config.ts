import { defineConfig } from 'vitest/config';

// These assertions inspect the already captured snapshot and the sole finished build.
export default defineConfig({ test: {
  include: ['tests/publication/snapshot.test.ts', 'tests/publication/build.test.ts',
    'tests/publication/destination.test.ts', 'tests/publication/payment-absence.test.ts',
    'tests/publication/payment-readiness.test.ts', 'tests/publication/payment-preflight.test.ts'],
  testTimeout: 120_000,
  hookTimeout: 30_000,
  fileParallelism: false,
} });
