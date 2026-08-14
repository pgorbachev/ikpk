import { defineConfig } from '@playwright/test';

/**
 * Демо-сценарии оплаты (3.9, 3.10a-2b) против сборки с DEMO_FORMS.
 *
 * Отдельный config, а не второй webServer в playwright.config.ts: общий массив
 * серверов стартовал бы dist-demo на каждом smoke/a11y-прогоне и падал бы без
 * `npm run build:demo`. Предмет этого файла — демо-клиент (`data-payment-demo`).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/payment-form-demo.spec.ts',
  timeout: 10000,
  use: {
    baseURL: 'http://127.0.0.1:4323',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'demo-forms',
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: 'node tests/helpers/preview-server.mjs --host 127.0.0.1 --port 4323 --outDir dist-demo',
    port: 4323,
    reuseExistingServer: false,
  },
});
