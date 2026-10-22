import { defineConfig } from '@playwright/test';

// Build and serve this worktree's controlled snapshot on a private dynamic port.
export default defineConfig({
  testDir: './tests',
  testMatch: 'schedule-month.spec.ts',
  globalSetup: './tests/helpers/schedule-month-global.ts',
  workers: 1,
  timeout: 10_000,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [['list'], ['json']] : [['list']],
  use: { headless: true, viewport: { width: 1280, height: 720 }, timezoneId: 'Europe/Moscow' },
  projects: [{ name: 'desktop' }],
});
