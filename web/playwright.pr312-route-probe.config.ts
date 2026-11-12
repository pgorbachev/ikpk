import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './diagnostics',
  testMatch: '**/pr312-image-route-probe.spec.ts',
  timeout: 3 * 60 * 1000,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 375, height: 812 },
  },
  projects: [{ name: 'mobile-route-probe', use: { viewport: { width: 375, height: 812 } } }],
});
