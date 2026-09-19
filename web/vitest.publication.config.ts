import { defineConfig } from 'vitest/config';

// These assertions inspect the already captured snapshot and the sole finished build.
export default defineConfig({ test: {
  include: ['tests/publication/*.test.ts'],
  testTimeout: 120_000,
  hookTimeout: 30_000,
  fileParallelism: false,
} });
