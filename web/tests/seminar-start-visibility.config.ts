import { defineConfig } from '@playwright/test';

// Self-contained fixture build/server; never attach to another worktree's preview.
export default defineConfig({
  testDir: '.',
  testMatch: 'seminar-start-visibility.browser.ts',
  globalSetup: './helpers/seminar-start-global.ts',
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 2_000 },
  use: { headless: true, viewport: { width: 1280, height: 900 } },
  projects: [
    { name: 'start-moscow', use: { timezoneId: 'Europe/Moscow' } },
    { name: 'start-los-angeles', use: { timezoneId: 'America/Los_Angeles' } },
  ],
});
