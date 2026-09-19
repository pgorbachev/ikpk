import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'publication-smoke.spec.ts',
  timeout: 30_000, retries: 0, workers: 1,
  outputDir: process.env.PUBLICATION_BROWSER_OUTPUT,
  use: {
    baseURL: process.env.PUBLICATION_BASE_URL,
    headless: true,
    launchOptions: { executablePath: process.env.PUBLICATION_CHROMIUM_EXECUTABLE },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
  ],
});
