import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 10000,
  use: {
    baseURL: 'http://127.0.0.1:4322',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 720 } },
      testIgnore: '**/compat.spec.ts',
    },
    {
      name: 'mobile',
      use: { viewport: { width: 375, height: 812 } },
      testIgnore: '**/compat.spec.ts',
    },
    {
      name: 'compat-chrome-desktop',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-firefox-desktop',
      use: { ...devices['Desktop Firefox'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-safari-desktop',
      use: { ...devices['Desktop Safari'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-ios-iphone-se',
      use: { ...devices['iPhone SE (3rd gen)'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-ios-iphone-14',
      use: { ...devices['iPhone 14'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-ios-ipad',
      use: { ...devices['iPad (gen 7)'] },
      testMatch: '**/compat.spec.ts',
    },
    {
      name: 'compat-android-chrome',
      use: { ...devices['Galaxy A55'] },
      testMatch: '**/compat.spec.ts',
    },
  ],
});
