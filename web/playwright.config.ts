import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // По умолчанию Playwright забирает и `*.test.ts` — то есть файлы vitest, которые
  // лежат в том же каталоге. На них он падает при СБОРЕ, не запустив ни одного теста
  // («Cannot read properties of undefined (reading 'config')» на первом же `describe`),
  // поэтому `playwright test` без явного списка файлов не работал вовсе.
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:4322',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  timeout: 10000,
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
  webServer: {
    // Через обёртку, а не напрямую `npm run preview`: с astro 7.2.0 `astro preview`
    // всегда уходит в фон и завершается, а Playwright считает это отказом
    // («exited early»), из-за чего локально не запускается ни один прогон с сервером.
    // Обёртка держит фронт независимо от версии astro, гасит фоновый сервер на выходе
    // и убирает свой же остаток перед запуском — при этом чужой сервер на порту она
    // не трогает, а отказывается работать. Подробности и границы — в её шапке.
    command: 'node tests/helpers/preview-server.mjs --host 127.0.0.1 --port 4322',
    port: 4322,
    // НЕ переиспользовать чужой сервер. `true` здесь означает: если на 4322 уже
    // кто-то слушает, Playwright молча подключится к нему — к preview, поднятому
    // час назад, из другого worktree, над другим `dist`. Прогон тогда зелёный про
    // код, которого в дереве уже нет, и это неотличимо от настоящего зелёного.
    //
    // `!process.env.CI` эту дыру НЕ закрывает: дефект локальный, а там значение
    // осталось бы `true`. Намеренное подключение к поднятому серверу живёт в
    // playwright.attached.config.ts, который webServer не поднимает вовсе.
    //
    // Границу честно: `false` запрещает подключаться к занятому порту, но свежесть
    // сборки не гарантирует — при свободном порте поднимется preview над тем
    // `dist`, что лежит. За свежесть отвечают скрипты (`test:build`, шаг build в CI).
    reuseExistingServer: false,
  },
});
