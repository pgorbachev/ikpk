import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './diagnostics',
  testMatch: 'pr312-image-srcset-probe.spec.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
  ],
});
