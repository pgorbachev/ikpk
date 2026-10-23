import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['seminar-schedule.spec.ts', 'seminar-layout-a11y.spec.ts'],
  globalSetup: './helpers/seminar-layout-global.ts',
  outputDir: '../test-results/seminar-layout',
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['list'], ['json']] : [['list']],
  workers: 1,
  timeout: 60_000,
  use: { headless: true, viewport: { width: 1280, height: 720 } },
  projects: [{ name: 'seminar-layout' }],
});
