# ИКПК — статический сайт (Astro)

Static-first ребилд [ikpk.su](https://ikpk.su) — Института клинической прикладной
кинезиологии. **256 страниц** (255 контентных + 404) собираются из снапшота данных
`discovery/entities/*.json` без CMS и бэкенда. Архитектура и план запуска:
[docs/plans/004-mvp-plan.md](../docs/plans/004-mvp-plan.md).

## Стек

- **Astro 6** (`output: 'static'`), интерактив — vanilla JS, без framework-островов
- `@astrojs/sitemap`; SEO-обвязка: canonical, OG, JSON-LD (5 типов)
- Данные: `src/lib/data.ts` — типизированные мемоизированные аксессоры над JSON
- `src/lib/html-cleaner.ts` — очистка легаси-HTML из старой CMS

## Команды

```sh
npm install
npx playwright install chromium   # один раз: браузер для e2e (версия из lock!)

npm run dev          # dev-сервер
npm run build        # прод-сборка в dist/ (256 страниц)
./serve.sh [port]    # стабильный локальный превью dist/ (дефолт: 4322)

npm run lint         # eslint
npm run typecheck    # astro check
npm test             # vitest unit (42)
npm run test:build   # build + проверки dist/ (28)
npm run test:e2e:smoke   # Playwright smoke, desktop+mobile (54)
npm run test:e2e:a11y    # axe-core: 0 critical/serious на 4 шаблонах
npm run test:e2e:compat  # 7 браузеров/устройств (nightly, не PR-гейт)
npx lhci autorun     # Lighthouse-бюджеты (см. lighthouserc.cjs)
```

> **Gotcha:** если e2e падают с `browserType.launch: Executable doesn't exist` —
> версия бинарника Playwright разошлась с `@playwright/test` из lock-файла.
> Лечится `npx playwright install chromium`.

## CI

| Workflow | Когда | Что |
|---|---|---|
| `lint.yml` | PR-гейт | eslint + astro check (web/cms/scripts) |
| `test.yml` | PR-гейт | vitest unit + build-тесты + Playwright smoke + axe |
| `security.yml` | PR-гейт + weekly | gitleaks + npm audit (prod, high) |
| `lighthouse.yml` | PR (пока не required) | бюджеты kpi-validation.md, медиана 5×4 шаблона |
| `nightly.yml` | cron 02:30 | compat 7 проектов + parity против живого ikpk.su |

Lighthouse станет required-чеком после Этапа 2 (миграция изображений):
сейчас шаблон «статья» ожидаемо валит LCP из-за хотлинка hero-изображений
со storage.yandexcloud.net.

## Тесты

- `tests/site.spec.ts` — smoke: ключевые страницы, SEO-теги, навигация
- `tests/a11y.spec.ts` — axe-core (WCAG 2.1 AA) на 4 шаблонах
- `tests/compat.spec.ts` — кросс-браузерная матрица (7 проектов)
- `tests/*-parity.spec.ts`, `compare.spec.ts` — паритет с живым ikpk.su
  (`PARITY_REMOTE=1`); после переключения DNS переводятся в snapshot-режим
- unit: `html-cleaner.test.ts`, `parity-compare.test.ts`; build-тесты гоняются
  против `dist/` (`vitest.build.config.ts`)

## Структура

```
src/
  pages/          # роуты: 17 .astro-файлов → 256 страниц (динамика из data.ts)
  layouts/        # BaseLayout: head, canonical/OG/JSON-LD, шапка/подвал
  components/     # по разделам: home/, schedule/, seminars/, articles/, …
  lib/            # data.ts (аксессоры), html-cleaner.ts, seo.ts
  styles/         # tokens.css (дизайн-токены), base, utilities
public/fonts/     # self-hosted шрифты
```

## Известные ограничения (до соответствующих этапов плана 004)

- Контентные изображения хотлинкаются со storage.yandexcloud.net → Этап 2
- Конверсионный контур (поиск, запись, подписка, чат) не подключён → Этап 4
- Деплой-таргет GitHub Pages временный; прод — VPS + Nginx → Этап 1
