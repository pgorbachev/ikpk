import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  baseURL: 'http://localhost:4322',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  timeout: 10000,
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: 'npm run preview -- --port 4322',
    port: 4322,
    reuseExistingServer: true,
  },
});
