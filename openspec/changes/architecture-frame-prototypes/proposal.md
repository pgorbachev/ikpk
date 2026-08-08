## Why

Владелец выбирает один из трёх каркасов подачи сайта (Institutional Editorial,
Faculty Human, Modular Education) до внедрения облика. Выбор по одной главной
ломается на семинаре и расписании (`docs/design/studio-references.md` §7.8). Нужны
live-прототипы на реальных данных под `DEMO_FORMS`, без утечки в прод.

Работа начата по плану 005 до перехода на OpenSpec; этот change фиксирует контракт
ретроспективно и явно ограничивает объём, уже частично реализованный в PR #36.

## What Changes

- Хаб сравнения и три направления: главная, семинар с датой, семинар без дат,
  расписание — только при `DEMO_FORMS` / `npm run build:demo`.
- Различающая архитектура подачи (§7): hero, событие, шапка семинара, форма
  расписания — не перестановка одних секций.
- Честные данные: преподаватели только из связи семинара/расписания; живые
  счётчики; легенда происхождения изображений; заглушки вместо неработающих
  фильтров.
- **Вне объёма этого change (сознательно отложено):** аккордеон учебного плана
  modular (§7.6); полное расписание на всех активных событиях с фильтрами,
  группировкой faculty по месяцам и бейджем «цикл семинаров» (§7.7); CI job с
  `build:demo` (пока TD-14).

## Capabilities

### New Capabilities

- `architecture-prototypes`: demo-only preview-маршруты трёх каркасов для выбора
  владельцем; состав страниц, различия подачи, честность данных, изоляция от прод.

### Modified Capabilities

- (нет — `openspec/specs/` не содержит смежных требований к preview)

## Impact

- `web/src/pages/preview/**`, `web/src/components/home/sections/*`,
  `web/src/components/seminars/SeminarArchitectureHeader.astro`, `web/src/lib/home.ts`,
  `web/src/lib/variants.ts`, тесты `seo-package` / unit.
- Прод-сборка без `DEMO_FORMS` не получает `/preview/*` (как `/demo-zayavka`).
- Не меняет боевые URL, CMS, деплой.
