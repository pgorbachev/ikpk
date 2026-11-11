# ИКПК — статический сайт (Astro)

Static-first сайт [ikpk.su](https://ikpk.su) — Института клинической прикладной
кинезиологии. Astro собирает страницы из снимка контента; источник и подготовка
снимка описаны в `src/lib/data.ts` и `scripts/prepare-snapshot.ts`.
Правила поведения находятся в `../openspec/specs/`.

## Стек

- **Astro 7** (`output: 'static'`, внутри Vite 8), интерактив — vanilla JS, без framework-островов
- `@astrojs/sitemap`; SEO-обвязка: canonical, OG, JSON-LD (5 типов)
- Данные: `src/lib/data.ts` — типизированные мемоизированные аксессоры над JSON
- `src/lib/html-cleaner.ts` — очистка легаси-HTML из старой CMS

## Команды

```sh
npm install
npx playwright install chromium   # один раз: браузер для e2e (версия из lock!)

npm run dev          # dev-сервер
npm run build        # прод-сборка в dist/ с поисковым индексом
./serve.sh [port]    # стабильный локальный превью dist/ (дефолт: 4322)

npm run lint         # eslint
npm run typecheck    # astro check
npm test             # unit- и render-тесты
npm run test:build   # build + проверки dist/
npm run test:e2e:smoke   # Playwright smoke, desktop+mobile
npm run test:e2e:a11y    # axe-core, desktop+mobile
npm run test:e2e:compat  # 7 браузеров/устройств (nightly, не PR-гейт)
npx lhci autorun     # Lighthouse-бюджеты (см. lighthouserc.cjs)
```

> **Gotcha:** если e2e падают с `browserType.launch: Executable doesn't exist` —
> версия бинарника Playwright разошлась с `@playwright/test` из lock-файла.
> Лечится `npx playwright install chromium`.

> **Gotcha:** e2e-тесты поиска требуют dist, собранный через `npm run build`
> (он включает pagefind-индексацию). После голого `astro build` поиск в
> превью не работает и тест Search упадёт.

> **Gotcha (lock-файл):** CI ставит зависимости через `npm ci` на **Node 22
> → npm 10**. Локальный `npm install` под **npm 11** пишет lock, который
> npm 10 считает рассинхронизированным и падает с
> `Missing: @emnapi/... from lock file` (npm 11 прунит optional-транзитивы
> платформенных вариантов `sharp`, npm 10 их требует). Локально это не
> видно: на darwin/arm64 `npm ci` пропускает `@img/sharp-wasm32` и не
> валидирует его поддерево.
> Поэтому lock-файл обновляем **под npm 10**:
> ```sh
> npx -y npm@10 install --package-lock-only
> npx -y npm@10 ci --dry-run   # должен пройти — это ровно то, что делает CI
> ```
> Такой lock совместим и с npm 11.

## CI

Состав проверок определяется файлами в `../.github/workflows/` и настройками репозитория.

## Тесты

- `tests/site.spec.ts` — smoke: ключевые страницы, SEO-теги, навигация
- `tests/a11y.spec.ts` — axe-core (WCAG 2.1 AA) на 4 шаблонах
- `tests/compat.spec.ts` — кросс-браузерная матрица (7 проектов)
- `tests/parity-compare.test.ts` — сравнение с живым ikpk.su при `PARITY_REMOTE=1`
- `tests/compare.spec.ts` — браузерное сравнение с живым ikpk.su
- unit: `html-cleaner.test.ts`; build-тесты, включая `parity-compare.test.ts`,
  запускаются против `dist/` (`vitest.build.config.ts`)

## Структура

```
src/
  pages/          # маршруты и страницы
  layouts/        # BaseLayout: head, canonical/OG/JSON-LD, шапка/подвал
  components/     # по разделам: home/, schedule/, seminars/, articles/, …
  lib/            # data.ts (аксессоры), html-cleaner.ts, seo.ts
  styles/         # tokens.css (дизайн-токены), base, utilities
public/fonts/     # self-hosted шрифты
```

## Медиа и выкладка

Медиа обрабатываются при подготовке сборки; команды находятся в `package.json`.
Инструкции по выкладке и эксплуатации — в `../docs/` и `../deploy/`.
