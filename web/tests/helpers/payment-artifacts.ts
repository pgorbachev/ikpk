/**
 * Браузерные наборы, разведённые по РОЛИ АРТЕФАКТА (задача 6.15).
 *
 * Источник требования: `openspec/changes/archive/2026-08-21-online-payment-flow/tasks.md`,
 * задача 6.15 (решение владельца от 2026-08-19, находка D3 сессии красных тестов) — организация
 * проверок живёт в `tasks.md`, а не в продуктовой спеке. Нормативны здесь только РОЛИ и
 * то, что каждая роль обязана нести (`specs/online-payment/spec.md`, Requirement «Роль
 * сборки объявлена перечислением, а не признаком «демо»», таблица четырёх ролей).
 *
 * КАТАЛОГА ВЫВОДА ЗДЕСЬ НЕТ НАМЕРЕННО, и причина не косметическая. `demo-gate.test.ts`
 * приписывает файлу ПРЕДМЕТ по объявленному литералу каталога — и делает это транзитивно,
 * через импорты. Файл про проводку никакого каталога не читает, поэтому объявлять имя здесь
 * значило бы записаться в проверки по выводу сборки и увести чужой гейт. Ожидаемый каталог
 * роли выводится из её же скрипта сборки (`tests/payment-artifact-roles.test.ts`): так
 * проверяется отображение «роль → сборка → раздача», а не совпадение с ещё одной копией имени.
 *
 * ЧТО ЗДЕСЬ НЕ НОРМАТИВНО, а выбрано этой сессией: номера портов,
 * имена конфигураций и npm-скриптов. Они собраны в одном месте, чтобы проверка проводки
 * (`tests/payment-artifact-roles.test.ts`) сверяла КОНФИГУРАЦИИ с этой записью, а не сама
 * с собой: конфигурации значения выписывают буквально и эту таблицу НЕ импортируют —
 * иначе согласие было бы по построению и правка порта в конфигурации прошла бы молча.
 *
 * ПОЧЕМУ РОЛЬ, А НЕ `DEMO_FORMS`: прежняя пара «основной config против
 * playwright.demo.config.ts» противопоставлялась по `DEMO_FORMS` — признаку форм ЗАЯВКИ
 * (Bitrix24), у которого с платёжным контуром общего только история. Роль сборки задаётся
 * `PAYMENT_ROLE` и наблюдается в артефакте как `data-payment-role`.
 */

/** Роли, у которых есть браузерный набор. `ci` формы не несёт, `prod` в прогонах не участвует. */
export type BrowserRole = 'preview' | 'stand';

export type BrowserArtifact = {
  role: BrowserRole;
  /**
   * Конфигурация для `astro preview`: у него НЕТ флага `--outDir` (он принимал его молча и
   * поднимал сервер над боевым выводом — см. шапку `astro.demo.config.mjs`).
   */
  astroConfig: string;
  port: number;
  playwrightConfig: string;
  /**
   * ВСЕ spec-файлы набора этой роли — перечень, а не один файл. У роли `stand` их три:
   * решением владельца от 2026-08-19 наборы транспорта (`payment-transport.spec.ts`) и
   * инварианта контура (`payment-contour.spec.ts`) переехали с боевого `dist` на артефакт
   * стенда. Раньше они шли основной конфигурацией, то есть по сборке роли `ci`, у которой
   * формы по контракту нет вовсе: их зелёный исход после реализации ролей означал бы
   * «проверять было нечего», а не «поведение верно».
   */
  specs: string[];
  npmScript: string;
  /** Команда сборки артефакта: она же обязана объявлять роль переменной `PAYMENT_ROLE`. */
  buildScript: string;
};

export const BROWSER_ARTIFACTS: Record<BrowserRole, BrowserArtifact> = {
  preview: {
    role: 'preview',
    astroConfig: 'astro.demo.config.mjs',
    port: 4323,
    playwrightConfig: 'playwright.preview.config.ts',
    specs: ['tests/payment-form-demo.spec.ts'],
    npmScript: 'test:e2e:payment-preview',
    buildScript: 'build:demo',
  },
  stand: {
    role: 'stand',
    astroConfig: 'astro.stand.config.mjs',
    port: 4324,
    playwrightConfig: 'playwright.stand.config.ts',
    specs: [
      'tests/payment-form.spec.ts',
      'tests/payment-transport.spec.ts',
      'tests/payment-contour.spec.ts',
    ],
    npmScript: 'test:e2e:payment-stand',
    buildScript: 'build:stand',
  },
};

/** Конфигурация прежней матрицы: противопоставлялась основной по `DEMO_FORMS`, а не по роли. */
export const RETIRED_DEMO_PLAYWRIGHT_CONFIG = 'playwright.demo.config.ts';
export const RETIRED_DEMO_NPM_SCRIPT = 'test:e2e:payment-demo';

/** Переменная сборки, которой роль задаётся. Шов назван тестами (см. `payment-build-role.test.ts`). */
export const PAYMENT_ROLE_ENV = 'PAYMENT_ROLE';
