import { defineConfig } from '@playwright/test';

/**
 * Браузерный набор АРТЕФАКТА РОЛИ `preview` (задача 6.15).
 *
 * Предмет — клиент сборки роли `preview` (`dist-demo`): демо-исход, повторяемость показа и
 * отсутствие удержания. Рабочей семантики (удержание, сверка, продолжение, дубль) здесь нет
 * по норме, поэтому её проверки живут в наборе роли `stand`
 * (`playwright.stand.config.ts`) — спека прямо называет попытку проверять их на `preview`
 * невыполнимой (`specs/online-payment/spec.md`, Requirement «Роли `ci` и `preview` не
 * создают платежей…»).
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ ПРЕЖНЕГО `playwright.demo.config.ts`, которым этот файл и был: тот
 * противопоставлялся основной конфигурации по `DEMO_FORMS` — признаку форм ЗАЯВКИ
 * (Bitrix24), к платёжному контуру отношения не имеющему. Разведение идёт по РОЛИ
 * артефакта: `PAYMENT_ROLE` на сборке, `data-payment-role` в разметке.
 *
 * Отдельный config, а не второй webServer в playwright.config.ts: общий массив серверов
 * стартовал бы `dist-demo` на каждом smoke/a11y-прогоне и падал бы без `npm run build:demo`.
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
    // Fail-closed, слой 1: ни одно внешнее ИМЯ в этом прогоне не разрешается — живая ЮKassa
    // и любой чужой хост недостижимы физически, а не «не предусмотрены тестом». Loopback
    // исключён: с него раздаётся сам preview-сервер. Слой 2, называющий предмет и роняющий
    // тест, — `tests/helpers/payment-network-guard.ts`.
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE 127.0.0.1'] },
  },
  projects: [
    {
      name: 'preview-role',
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    // `--config` ВЫБИРАЕТ вывод: у `astro preview` нет флага `--outDir`, он принимал
    // его молча и поднимал сервер над боевым `dist`. `--outDir` здесь — то, что
    // обёртка СВЕРЯЕТ с фактически отданным содержимым.
    command:
      'node tests/helpers/preview-server.mjs --host 127.0.0.1 --port 4323 ' +
      '--config astro.demo.config.mjs --outDir dist-demo',
    port: 4323,
    reuseExistingServer: false,
  },
});
