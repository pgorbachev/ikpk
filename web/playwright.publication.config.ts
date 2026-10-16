import { defineConfig, devices } from '@playwright/test';
import { candidateFiles, compatibilityProjects } from './tests/helpers/publication-browser-inventory';

// The adapter owns the preview of the already built candidate. This config MUST NOT build.
export default defineConfig({
  testDir: './tests', timeout: 60_000, retries: 0, workers: 1,
  outputDir: process.env.PUBLICATION_BROWSER_OUTPUT,
  use: {
    baseURL: process.env.PUBLICATION_BASE_URL, headless: true, serviceWorkers: 'block',
    screenshot: 'only-on-failure',
  },
  projects: [
    ...['desktop', 'mobile'].map((name) => ({ name, testMatch: candidateFiles,
      use: { launchOptions: { executablePath: process.env.PUBLICATION_CHROMIUM_EXECUTABLE }, viewport: name === 'desktop' ? { width: 1280, height: 720 } : { width: 375, height: 812 } } })),
    { name: 'footer-tablet', testMatch: 'footer-social.spec.ts', use: { launchOptions: { executablePath: process.env.PUBLICATION_CHROMIUM_EXECUTABLE }, viewport: { width: 600, height: 800 } } },
    ...compatibilityProjects.map((name, index) => ({ name, testMatch: 'compat.spec.ts', use: {
      ...(index === 0 || index === 6 ? { launchOptions: { executablePath: process.env.PUBLICATION_CHROMIUM_EXECUTABLE } } : {}),
      ...devices[['Desktop Chrome', 'Desktop Firefox', 'Desktop Safari', 'iPhone SE (3rd gen)', 'iPhone 14', 'iPad (gen 7)', 'Galaxy A55'][index]],
    } })),
  ],
});
