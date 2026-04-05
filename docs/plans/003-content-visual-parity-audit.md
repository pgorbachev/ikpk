# Единый audit: content/visual parity

**Дата:** 2026-04-04  
**Статус:** В работе  
**Приоритет:** P1  
**Основание:** после `css-ui-foundation` и первичного compare-check нужен единый audit по visual/content parity относительно production `https://ikpk.su`.

## Цель

Зафиксировать:

1. Что уже совпадает с production по структуре, SEO и базовому контенту.
2. Где rebuild заметно ушёл от production по визуальному языку, составу блоков и поведению.
3. Какие разрывы обязательно закрыть до go-live, а какие можно считать допустимыми или перенести в polish.

## Decision Rule

Для visual parity в этой фазе приоритет у **тона original**, а не у условно более современного или более аккуратного локального UI.

Это означает:

- если локальное решение выглядит “чище”, но уводит сайт в другой visual language, его не считать улучшением по умолчанию;
- neutral surfaces, contrast, density, card treatment и CTA tone нужно выравнивать к production;
- любые осознанные departures от original помечать как product deviation, а не как parity fix.

## Scope

### Страницы

- `/`
- `/kontakty`
- `/statyi`

### Проверяемые аспекты

- Header
- Left sidebar
- Hero / page header
- Главные карточечные паттерны
- Новости / списки контента
- Контакты / article listing behavior
- Footer
- Общий visual language

## Метод

### 1. Existing automated parity baseline

База: `web/tests/compare.spec.ts`

Что уже было подтверждено ранее:

- ключевые страницы доступны;
- `title`, `h1`, meta description присутствуют;
- canonical / OG / JSON-LD присутствуют;
- верхнеуровневая навигация и footer-структура не потеряны;
- обязательные секции главной в rebuild есть.

### 2. Live DOM / computed-style audit

Сравнивались production и local preview:

- `https://ikpk.su`
- `http://127.0.0.1:4322`

Проверялись:

- состав интерактивных элементов в header;
- computed styles header / sidebar / page headers;
- состав и порядок top-level секций;
- наличие или отсутствие behavior-паттернов;
- тип карточек и их fit;
- привязка расхождений к текущим компонентам в `web/src`.

## Executive Summary

### Что уже близко к parity

- Контентная и SEO-база rebuild в целом сохранена.
- Ключевые маршруты и базовая информационная архитектура сайта на месте.
- Footer и основная навигация по смыслу совпадают.
- Главная, контакты и список статей не выглядят как сломанные или незаполненные страницы.

### Что не совпадает

- Header на rebuild функционально беднее production.
- Desktop sidebar в rebuild визуально тяжелее и декоративнее оригинала.
- На главной потеряно поведение news rotator.
- Главная ушла в другую композицию после блока новостей.
- Для эмблем институтов используется неподходящий media pattern с `object-fit: cover`.
- На `/kontakty` и `/statyi` rebuild упростил presentation layer сильнее, чем допустимо для visual parity.
- Типографика page headers на `/kontakty` и `/statyi` отличается от production.
- Tonal balance rebuild в целом должен быть возвращён ближе к original, даже там, где local UI субъективно выглядит современнее.

## Findings

### [P1] Header rebuild функционально уступает production

**Страницы:** site-wide, наиболее заметно на `/`

**Evidence**

- Production top bar содержит:
  - телефон;
  - поиск;
  - кнопку версии для слабовидящих;
  - switch темы.
- Local header содержит только:
  - mobile menu toggle;
  - logo;
  - телефон.
- Computed style:
  - production header background: `rgb(250, 250, 250)`
  - local header background: `rgb(255, 255, 255)`

**Почему это важно**

Это не cosmetic detail. Здесь одновременно теряется:

- функциональный parity;
- accessibility parity;
- узнаваемый visual chrome верхней панели.

**Затронутый код**

- `web/src/components/Header.astro`

**Что менять**

- Добавить search trigger в `header-right`.
- Добавить control для режима слабовидящих.
- Добавить theme switch.
- После возврата controls подогнать spacing и фон шапки под production.

---

### [P1] Desktop sidebar в rebuild визуально тяжелее оригинала

**Страницы:** site-wide, особенно заметно на `/`

**Evidence**

- Production sidebar:
  - светлый фон `rgb(250, 250, 250)`;
  - flat rows;
  - `border-radius: 0`;
  - `box-shadow: none`;
  - активный пункт выделяется без pill-card treatment.
- Local sidebar:
  - белый фон `rgb(255, 255, 255)`;
  - каждый link выглядит как отдельная rounded card;
  - `border-radius: 12px`;
  - border + shadow на каждом пункте;
  - выраженная зелёная окраска активного пункта.

**Почему это важно**

Sidebar занимает постоянную площадь экрана и сильнее всего формирует первое впечатление от rebuild. Сейчас именно он делает интерфейс тяжелее и менее похожим на original.

**Затронутый код**

- `web/src/components/Sidebar.astro`
- `web/src/styles/tokens.css`

**Что менять**

- Для desktop убрать pill-card treatment у `.menu-link`.
- Убрать per-item border/shadow/radius.
- Сделать строки flush к контейнеру и ближе к production navigation chrome.
- Отдельно решить, нужны ли иконки на desktop вообще: в оригинале они не формируют основной визуальный ритм.

---

### [P1] На главной потерян behavior-паттерн новостей

**Страницы:** `/`

**Evidence**

- Production в блоке `Новости` имеет controls `Previous slide` / `Next slide`.
- Local homepage жёстко ограничивает список новостей:
  - `const news = getNews().slice(0, 4);`
- Local рендерит новости как статическую `grid-4`.

**Почему это важно**

Это не только визуальный gap, но и поведенческий. Rebuild показывает первые 4 карточки и не даёт способа посмотреть остальные в том же контексте.

**Затронутый код**

- `web/src/pages/index.astro`
- `web/src/styles/utilities.css`

**Что менять**

- Убрать жёсткий `slice(0, 4)` как default behavior.
- Вернуть carousel/rotator или другой эквивалентный паттерн, если цель именно parity.
- Добавить controls и проверки на их наличие.

---

### [P1] Главная ушла в другую информационную архитектуру после блока новостей

**Страницы:** `/`

**Evidence**

- Production после `Новости` переходит к newsletter signup.
- Local после `Новости` добавляет отдельные секции:
  - `Наши институты`
  - `Акции и скидки`
- Эти секции делают главную длиннее и заметно более card-heavy.

**Почему это важно**

Даже если секции сами по себе полезны, это уже другая композиция homepage. Для parity это structural drift, а не minor difference.

**Затронутый код**

- `web/src/pages/index.astro`

**Что менять**

- Если go-live критерий: близкое воспроизведение production homepage, убрать эти секции с `/` или перенести в другие маршруты.
- Если секции решено оставить, считать это explicit product deviation, а не parity.

---

### [P1] Эмблемы институтов рендерятся неподходящим способом

**Страницы:** `/`

**Evidence**

- Карточки `Наши институты` используют общий `MediaCard`.
- `MediaCard` рендерит изображения через `object-fit: cover`.
- Для логотипа ИКПК:
  - natural ratio: `406 x 112` (`3.625`)
  - card media ratio: `285 x 190` (`1.5`)
  - фактический горизонтальный crop: около `58.6%` от нарисованной ширины
- Для логотипов Апледжера и Барраля crop тоже есть, около `10%`.

**Почему это важно**

Это не subtle issue. Для emblem/logo media `cover` концептуально неверен: он обрезает смысловой контент.

**Затронутый код**

- `web/src/pages/index.astro`
- `web/src/components/ui/MediaCard.astro`

**Что менять**

- Для emblem/logo cards ввести отдельный режим:
  - `object-fit: contain`;
  - внутренние отступы;
  - нейтральный фон;
  - другой aspect ratio при необходимости.
- Не использовать generic media-card crop pattern для институциональных логотипов.

---

### [P1] `/statyi` ушёл от production по behavior и объёму списка

**Страницы:** `/statyi`

**Evidence**

- Production:
  - `h1` имеет `48px / 500`;
  - listing визуально построен на крупных card tiles с `border-radius: 20px` и shadow;
  - присутствует пагинация (`1 2 3 4 5 12`).
- Local:
  - `h1` имеет `36px / 600`;
  - рендерит `articles.map(...)` без пагинации;
  - выводит все статьи сразу;
  - body text на странице заметно длиннее (`15855` символов против `5138` в production snapshot);
  - карточки проще: `border-radius: 12px`, без shadow.

**Почему это важно**

Для listing page это одновременно:

- visual drift;
- behavior drift;
- информационная перегрузка;
- потенциальный performance drift.

**Затронутый код**

- `web/src/pages/statyi/index.astro`
- `web/src/components/ArticleCard.astro`
- `web/src/components/ui/MediaCard.astro`

**Что менять**

- Вернуть pagination или другой parity-equivalent pattern.
- Подтянуть `h1` и карточки списка ближе к original.
- Если в product решено оставить all-items listing, это надо отдельно принять как product deviation.

---

### [P2] `/kontakty` в rebuild чище, но беднее по информационной плотности

**Страницы:** `/kontakty`

**Evidence**

- Production:
  - `h1`: `48px / 500`
  - body snapshot length: `3894`
  - более насыщенный presentation layer, крупные visual blocks.
- Local:
  - `h1`: `36px / 600`
  - body snapshot length: `1669`
  - используется сильно упрощённая grid из контактных карточек;
  - вместо richer map/location block используется placeholder-card с ссылкой `Открыть на карте`.

**Почему это важно**

Страница не выглядит сломанной и функционально годна, но rebuild сильно уплотнил и упростил presentation layer по сравнению с production. Это уже ближе к redesign, чем к parity.

**Затронутый код**

- `web/src/pages/kontakty.astro`
- `web/src/components/ui/PageHeader.astro`
- `web/src/components/ui/AsideCard.astro`

**Что менять**

- Подтянуть page-header typography.
- Решить, нужно ли возвращать более насыщенный location block / map treatment.
- Проверить, не была ли потеряна часть служебной информации при сокращении `body_html`.

---

### [P2] Общий visual language rebuild системно отличается от original

**Страницы:** `/`, `/kontakty`, `/statyi`, site-wide

**Evidence**

- В rebuild токены построены вокруг:
  - насыщённой green palette;
  - `8px/12px` radii;
  - rounded cards;
  - зелёных CTA;
  - более современного и аккуратного, но менее аутентичного UI.
- В original визуальный язык более:
  - плоский;
  - светлый;
  - спокойный;
  - менее “карточный”;
  - более утилитарный.

**Почему это важно**

Даже после фикса отдельных блоков rebuild всё ещё может ощущаться как другой сайт, если не пересобрать shared UI language.

**Затронутый код**

- `web/src/styles/tokens.css`
- `web/src/styles/utilities.css`
- shared UI components

**Что менять**

- Нужен отдельный visual parity pass на shared tokens и базовые card/button patterns.
- Особенно важно для:
  - header;
  - sidebar;
  - CTA;
  - page headers;
  - content cards.

---

## Additional Findings From Surface Audit

### [P1] `Наши преимущества` в production использует отдельный elevated-surface pattern, а не generic card

**Страницы:** `/`

**Evidence**

- В production карточка преимущества рендерится как внешний shell:
  - background: `rgb(250, 250, 250)`
  - border-radius: `20px`
  - box-shadow: `0 2px 12px 0 rgba(0, 0, 0, 0.16)`
- Внутренний текстовый блок у production прозрачный и без своей тени.
- В local блок `Наши преимущества` собран на generic `.card`:
  - background: `rgb(255, 255, 255)`
  - border-radius: `8px`
  - border: `1px solid rgb(229, 229, 229)`
  - тень только на hover.

**Почему это важно**

Это отдельная visual family original homepage. Пока rebuild натягивает её на общий utility-card, он будет системно промахиваться по тону, плотности и характеру surface.

**Затронутый код**

- `web/src/pages/index.astro`
- `web/src/styles/utilities.css`

**Что менять**

- Вынести этот паттерн в отдельный homepage-specific component или variant.
- Не расширять под него общий `.card`.
- Отдельно зафиксировать:
  - off-white shell;
  - крупный radius;
  - persistent shadow;
  - прозрачный/простой inner content.

---

### [P1] `/kontakty` в rebuild собран как набор generic cards, а production использует один доминирующий info shell

**Страницы:** `/kontakty`

**Evidence**

- Production:
  - крупный центральный shell `877px` шириной;
  - white surface;
  - `border-radius: 20px`;
  - `box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.16)`;
  - внутри уже раскладываются address / phone / hours и другие контактные элементы.
- Local:
  - сетка из нескольких `contact-block`;
  - каждая карточка имеет `8px` radius, border и hover-only behavior;
  - справа отдельные `AsideCard`, тоже построенные на generic bordered surface.

**Почему это важно**

Здесь divergence не только в styling. Страница использует другую structural logic: production опирается на один сильный information panel, local дробит его на набор унифицированных карточек. Это делает страницу аккуратной, но уже другой по visual hierarchy.

**Затронутый код**

- `web/src/pages/kontakty.astro`
- `web/src/components/ui/AsideCard.astro`
- `web/src/components/ui/PageHeader.astro`

**Что менять**

- Не пытаться доводить `/kontakty` только косметикой поверх `contact-block`.
- Нужен отдельный `ContactPanel` / `InfoShell` pattern, а не набор generic cards.
- `AsideCard` оставить для low-emphasis secondary info, но не использовать как основной structural surface страницы.

---

### [P1] `/statyi` использует не тот card family и в текущем local preview показывает runtime drift

**Страницы:** `/statyi`

**Evidence**

- Production article cards:
  - white surface;
  - `border-radius: 20px`;
  - `box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.16)`;
  - на странице присутствуют sort/pagination controls.
- Local code уже пытается вернуть pagination, но в текущем preview `http://127.0.0.1:4322/statyi` наблюдается:
  - `68` article links в DOM;
  - `0` pagination controls;
  - `0` `data-page-button`;
  - карточки по-прежнему ближе к generic `MediaCard` (`12px`, border, без постоянной тени).

**Почему это важно**

Здесь сразу два разрыва:

- visual family list cards не совпадает с original;
- current preview/runtime не совпадает даже с предполагаемой локальной логикой pagination.

**Затронутый код**

- `web/src/pages/statyi/index.astro`
- `web/src/components/ArticleCard.astro`
- `web/src/components/ui/MediaCard.astro`

**Что менять**

- Развести article-list cards и generic media cards в разные patterns.
- Убедиться, что preview/runtime действительно использует актуальную pagination-логику.
- Для acceptance на `/statyi` проверять не только код и тесты, но и фактический DOM local preview.

---

### [P2] Footer использует другой typographic pattern, чем production

**Страницы:** site-wide

**Evidence**

- Local footer headings:
  - uppercase;
  - `14px`;
  - заметно более utilitarian.
- Production footer headings:
  - в normal case;
  - визуально мягче и ближе к title-case grouping original.

**Почему это важно**

Footer не является top blocker, но это ещё один признак того, что rebuild слишком часто переводит original UI в generic component system.

**Затронутый код**

- `web/src/components/Footer.astro`

**Что менять**

- Подтянуть footer headings к production casing и typography.
- Не использовать uppercase как default для secondary nav groups без прямого соответствия original.

## Component Structure Recommendations

### 1. Site Chrome

**Зона:** `Header`, `Sidebar`, `Footer`

**Рекомендация**

- Держать как отдельную family shared chrome components.
- Не смешивать их visual rules с generic card/token utilities.
- Для них важнее parity с original chrome, чем переиспользуемость любой ценой.

### 2. Elevated Surface Family

**Зона:** homepage advantages, крупные info-shells, article listing cards, вероятно часть крупных content panels

**Сигнатура production**

- white или off-white background;
- `20px` radius;
- persistent shadow;
- ощущение крупного самостоятельного surface.

**Рекомендация**

- Вынести в отдельный component/variant family (`SurfaceCard`, `ElevatedPanel`, `FeatureCard`, `ArticleTile`).
- Не строить её на generic `.card` с hover-only shadow.

### 3. Border Card Family

**Зона:** secondary/low-emphasis panels, quick links, service notes, technical asides

**Сигнатура**

- border-first;
- меньший radius;
- little or no persistent shadow.

**Рекомендация**

- Здесь можно оставить generic utility card / aside-card.
- Но не использовать этот family как substitute для production elevated surfaces.

### 4. Media-Led Cards

**Зона:** новости, статьи, program cards, другие image-led blocks

**Рекомендация**

- Текущий `MediaCard` слишком универсален.
- Развести хотя бы на variants:
  - `article`
  - `news`
  - `program/logo`
- Особенно важно, потому что:
  - article cards в original используют другой shell;
  - logo/program cards не должны наследовать destructive crop behavior;
  - news cards завязаны на slider-specific layout.

### 5. Page Headers

**Зона:** `/kontakty`, `/statyi`, другие content/listing pages

**Рекомендация**

- `PageHeader` оставить отдельным компонентом, но матчить его под production ranges.
- Не компенсировать page-level visual gaps только размером `h1`; важны ещё intro, spacing и отношение к следующему content block.

## Classification

### Must Match Before Go-Live

- Header controls parity on `/` and site-wide.
- Desktop sidebar restyle toward production.
- Возврат news behavior parity на homepage.
- Решение по structural drift homepage после `Новости`.
- Исправление logo/emblem fit на homepage.
- Решение по `/statyi` pagination parity.
- Возврат общего tonal balance к original для header, sidebar, cards, CTA и page headers.

### Acceptable Differences

- Небольшие расхождения в exact neutral shades вроде `250` vs `255`, если общая композиция и токены совпадают.
- Чуть более компактный copy в отдельных контентных блоках, если не теряется смысл и CTA.
- Более чистая локальная реализация markup при сохранении user-facing structure.

### Post-Launch Polish

- Тонкая настройка hero и CTA на homepage.
- Дополнительная типографическая калибровка section titles.
- Смягчение общего “card-heavy” ощущения rebuild.
- Пересмотр нужности некоторых icon treatments в navigation и contact cards.

## Что в rebuild уже может быть лучше production

Это не отменяет gaps parity, но важно зафиксировать:

1. **Читаемость и cleanliness local UI выше в ряде блоков**
   - rebuild чище по сетке;
   - меньше визуального шума;
   - проще считывается структура контента.

2. **`/kontakty` локально организован более аккуратно**
   - контактные сущности разложены понятнее;
   - карта и quick links выделены явно;
   - информация легче сканируется.

3. **`/statyi` локально даёт больше контекста на один экран списка**
   - больше excerpt text;
   - более predictable card pattern;
   - проще серийно просматривать материалы.

4. **Shared component system в rebuild поддерживаемее**
   - единые tokens;
   - единый `MediaCard`;
   - повторно используемые sidebar / aside / header patterns.

Вывод: rebuild местами выглядит современнее и аккуратнее, но в рамках parity это не является целевым критерием. Целевой критерий — вернуть tonal balance и visual language original, а локальные “улучшения” сохранять только там, где они не меняют узнаваемый характер production.

## Автоматизация через Playwright

### Homepage

- Проверять наличие в header:
  - phone;
  - search trigger;
  - low-vision toggle;
  - theme switch.
- Проверять, что блок `Новости` не ограничен статическими 4 карточками без controls.
- Проверять порядок top-level секций после `Новости`.
- Проверять, что logo/emblem cards не используют destructive crop.
- Добавить desktop screenshot-diff для:
  - header + sidebar;
  - hero;
  - news strip;
  - нижней части homepage.

### `/kontakty`

- Проверять `h1` typography against expected range.
- Проверять наличие map/location block, а не только внешней ссылки.
- Проверять, что page не теряет критичный contact content volume.

### `/statyi`

- Проверять наличие pagination или зафиксированного альтернативного pattern.
- Проверять, что `h1` и card presentation не уходят слишком далеко от baseline.
- При screenshot-diff отдельно сравнивать first row article cards.

## Итог

Если критерий успеха — **functional/content parity**, rebuild уже близок к целевому состоянию.

Если критерий успеха — **визуально и поведенчески близкая копия production**, перед go-live остаётся отдельный P1-pass по:

- header;
- sidebar;
- homepage behavior;
- homepage composition;
- article listing behavior;
- shared visual tokens.
