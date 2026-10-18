import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'staging193-live-release.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'https://staging.ikpk.su',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
  ],
});
