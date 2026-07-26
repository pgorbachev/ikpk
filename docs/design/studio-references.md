# Каркас-шаблон: студийные референсы, разрыв и спецификация токенов

Дата: 2026-07-26. Автор: исследование по задаче «каркас должен быть ультра-современным».
Код не менялся — документ только описывает предложения.

> Владелец потребовал оценивать любое изменение внешнего вида по полноценным мокапам
> страниц в нескольких вариантах. Три различимых направления под механизм
> `/preview/[variant]` — в **§7**. Токены в §3–4 — общий фундамент, одинаковый для всех
> трёх направлений; расходятся направления только значениями, перечисленными в §7.2.
>
> **§8** — разбор пяти референсов, присланных владельцем (Branksome Hall, Wellesley,
> IFM, Real World CE, Reed), и сверка с направлениями A/B/C: фотоинвентарь и решение
> по «людям как главному образу» (§8.1), готовые решения для расписания и траекторий
> из IFM (§8.2), порядок блоков страницы семинара (§8.3), сокращение видимого объёма
> и вопросы к заказчику (§8.4), аудитории по данным (§8.5).

## 0. Как собраны данные

Значения в этом документе **не на глаз**. Каждый референс открыт в Chrome, с него
снят `getComputedStyle` по заголовкам, тексту, кнопкам, теням, радиусам, фокус-рингам
и максимальным ширинам. Там, где у студии есть публичный дизайн-токен-слой
(Linear, Piccalilli), выгружены все `--*` с `:root`. Наша `/oplata` и живой старый
сайт `ikpk.su/oplata` замерены тем же скриптом, поэтому сравнение — в одних единицах.

Мера успеха «ультра-современного каркаса» на 260 статических страницах — не эффекты,
а четыре вещи, которые есть у всех сильных референсов и которых у нас нет:
**(1)** нормальная шкала (типографика/отступы/радиусы/тени как ступени, а не 2–3 значения,
**(2)** семантический слой цвета (поверхности / границы / текст), а не «два серых»,
**(3)** обязательный компонент «шапка страницы», который делает любую контентную
страницу законченной, **(4)** многослойные тени и осознанные состояния (hover/focus/open).

---

## 1. Референсы

Шесть первых — основные (с них берём конкретные значения). Остальные — на конкретные узлы.

| # | Референс | Что там реально сделано (замеренные значения) | Что забираем в статику | Цена |
|---|---|---|---|---|
| 1 | **Piccalilli** <br>`https://piccalil.li/blog/a-more-modern-css-reset/`<br>(и метод: `https://piccalil.li/complete-css/lessons/7`) | Полный Utopia-токен-слой в реальном контентном сайте **на Astro**. `--measure: 65ch`, `--measure-m: 45ch`, `--measure-l: 75ch`. Шкала leading как отдельные токены: `--leading: 1.4`, `--leading-short: 1.3`, `--leading-slim: 1.2`, `--leading-fine: 1.1`, `--leading-flat: 1`. `--heading-kerning: -0.015em`, `--heading-line-height: 1.1`. Текст fluid: `--size-step-0: clamp(1.0625rem, …, 1.3125rem)` = **17→21px базовый текст**. Отступы — парные диапазоны (`--space-s-m`, `--space-m-l`, `--space-l-xl`), не одиночные значения. Токены таблиц отдельно (`--global-style-table-th-text-transform: uppercase`). `--focus-ring-width: 2px`, `--text-decoration-thickness: 2px`, `--text-decoration-offset: 0.2ex` | Целиком метод: fluid-шкала на `clamp()`, `--measure` в `ch`, leading как токены, парные отступы, токены таблиц. Это ровно наш класс задач — контент + минимум JS | 0 KB рантайма, ~+2 KB CSS |
| 2 | **GOV.UK Design System** <br>`https://design-system.service.gov.uk/styles/type-scale/` | Опубликована вся шкала в двух состояниях. Десктоп: 80/80, 48/50, 36/40, 27/30, 24/30, **19/25 (body)**, 16/20. Мобайл: 53/55, 32/35, 27/30, 21/25, 21/25. Цвет текста `#0b0c0c` — почти чёрный, **не серый**. Контейнер 1100px. Кнопка: 19px, `border-radius: 0`, `box-shadow: 0 2px 0 #083d29` («полка» вместо размытой тени). Фокус: `background:#ffdd00; box-shadow: 0 -2px 0 #ffdd00, 0 4px 0 #0b0c0c; outline: 3px solid transparent; outline-offset: 1px` | Базовый кегль **19px, не 16**; почти-чёрный основной текст; отдельная мобильная шкала (у нас реализуем через `clamp`); идея заметного фокус-ринга в 2 слоя | 0 KB |
| 3 | **Linear** <br>`https://linear.app/` | Выгружены токены. Радиусы ступенями: 4/6/8/12/16/24/32/999. Тени ступенями: `--shadow-low: 0 2px 4px #0000001a`, `--shadow-medium: 0 4px 24px #0003`, `--shadow-high: 0 7px 32px #00000059` + `--shadow-stack-low` из **5 микрослоёв** (`0 8px 2px #0000, 0 5px 2px #00000003, 0 3px 2px #0000000a, 0 1px 1px #00000012, 0 0 1px #00000008`). Вес — вариативный: 400/510/**590**/680, не 400/600/700. Текст: `--text-regular: .9375rem/1.6, letter-spacing -.011em`; `--text-small: .875rem/calc(21/14), -.013em`. `--border-hairline: .5px`. H1 — **64px/64px, вес 510, tracking -0.022em** | Шкала радиусов и шкала теней (не по 2 значения); правило «крупнее кегль → меньше вес»; отрицательный tracking на крупном; хайрлайн-границы. У нас Inter variable 400–700 ⇒ веса 510/560/620 **бесплатны** | 0 KB |
| 4 | **MIT Sloan Executive Education** <br>`https://executive.mit.edu/` | Прямой аналог: платные программы для практиков. H1 40/48, вес 500, tracking −1.5%. Кнопка: 16px/**700**, `padding: 18.5px 24px` (высота ~55px), `border-radius: 1.5px` — почти прямоугольная, институционально. Контейнер 1440, текстовая колонка **616–864px**. Карточки: `rgba(0,0,0,.1) 0 16px 32px -4px, rgba(0,0,0,.05) 0 4px 4px -4px` — двухслойно. Фокус — двойной ринг: `rgb(151,137,140) 0 0 0 1px, #fff 0 0 0 2px` | Крупные высокие CTA (min-height ≥ 44–52px, не 37px как у нас); малый радиус для «солидности»; узкая текстовая колонка при широком контейнере; двухслойная тень; двойной фокус-ринг | 0 KB |
| 5 | **Wellcome Collection** <br>`https://wellcomecollection.org/stories` | Медицинско-издательский, тяжёлого JS в отдаче нет. Базовый текст **18.4px / 27.6px (1.5)**, цвет `#121212`. Текстовая колонка **620px**, контейнер 1440. Заголовки `letter-spacing: -0.5px`. Фокус — толстое белое кольцо `#fff 0 0 0 4.8px`. Радиусы всего 4/6/50% | Доверие достигается кеглем и колонкой, а не украшениями: 18–19px основной текст на 620–660px колонке. Именно этого не хватает нашим статьям и /oplata | 0 KB |
| 6 | **Stripe** <br>`https://stripe.com/` | H1 48/55.2 (1.15), **вес 300**, tracking −0.02em. H2 32/35.2 (1.1), −0.02em. Тени всегда многослойные и **тонированные, не чёрные**: `rgba(50,50,93,.25) 0 30px 60px -10px, rgba(0,0,0,.1) 0 30px 60px -50px`; `rgba(50,50,93,.12) 0 16px 32px`; `rgba(0,0,0,.06) 0 4px 24px, rgba(0,0,0,.03) 0 1px 2px`. Базовый радиус 6px, крупный 16px. Текстовые колонки 687/816/856px | Тонирование тени в цвет бренда (наши `rgba(0,0,0,.06)` читаются как грязь); плотный tracking и лёгкий вес на display-кегле; два радиуса — контрол vs карточка | 0 KB |
| 7 | **NHS Design System** <br>`https://service-manual.nhs.uk/design-system/styles/typography` | Базовый текст **19px на больших экранах, 16px на маленьких**; лид-абзац 26px; мелкий 16/14. Шкала объявлена явными ступенями: 14, 16, 19, 22, 26, 36, 48, 64 | Подтверждает 19px как медицинский стандарт; ступени 14/16/19/22/26/36/48 как ориентир нашей fluid-шкалы | 0 KB |
| 8 | **Radix Colors** <br>`https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale` | 12 ступеней с закреплённой семантикой: 1 фон приложения, 2 subtle-фон (карточки, сайдбары), 3/4/5 фон UI-элемента (норма/hover/active), **6 неинтерактивная граница, 7/8 интерактивная граница и фокус-ринг**, 9 сплошной цвет (максимальная хрома), 10 его hover, 11 низкоконтрастный текст (гарантия Lc 60 APCA на ступени 2), 12 высококонтрастный (Lc 90) | Модель, которой у нас нет вообще: границы и фокус — **отдельные ступени**, а не «тот же серый». Берём как каркас семантического слоя | 0 KB |
| 9 | **Vercel Geist** <br>`https://vercel.com/geist/colors` | 10 ступеней, семантика по диапазонам: 100–300 фоны компонента (норма/hover/active), 400–600 границы (норма/hover/active), 700–800 высококонтрастные фоны, 900–1000 текст и иконки (secondary/primary) | Более компактная альтернатива Radix; ключевое — **hover/active как отдельные ступени палитры**, а не `opacity`/`filter` на ходу | 0 KB |
| 10 | **Utopia** <br>`https://utopia.fyi/type/calculator/` | Метод: две опорные точки вьюпорта + два модульных коэффициента (например 1.2 на 320px и 1.25 на 1240px) → генерируются `clamp()` для всех ступеней. Дефолт: −2…+5 от базы | Инструмент, которым считаем нашу шкалу. Важно: генерирует `vi` — **для Safari 14 переписываем на `vw`** | 0 KB |
| 11 | **Cosmic Themes** <br>`https://cosmicthemes.com/themes/` | Ровно та «заготовка», о которой говорил владелец: коммерческие Astro-киты (~$89), 25+ шаблонов. Замерено на витрине: контейнер 1152px, prose-колонка **672px**, H1 60/60 вес 500, H2 20/28 вес 500, тени в один многослойный набор | Подтверждение целевой геометрии кита: контейнер ~1150–1200, prose ~670. Полезно как чек-лист состава кита (страничные шапки, секционные полосы, CTA-полосы, прайс-таблицы, FAQ) | 0 KB |
| 12 | **Awwwards / Typography** <br>`https://www.awwwards.com/websites/typography/` | Галерея для регулярного сканирования текущего языка (2025–2026): крупный display, плотный tracking, узкая колонка, монохром + один акцент | Только как источник насмотренности. Одностраничные WebGL-эксперименты оттуда **не берём** — они ломают бюджеты | — |

Отдельно, как контрольный образец: **старый сайт `https://ikpk.su/oplata`**. Он не «лучше по дизайну»,
но у него три вещи, которые мы потеряли при переносе, и они замерены в §2.4.

---

## 2. Разрыв с текущим состоянием

Замеры нашей `/oplata` (viewport 1280) и того же на старом сайте.

### 2.1 Типографика

| Ось | У нас сейчас | Референсы | Разрыв |
|---|---|---|---|
| Базовый кегль | **16px / 25.6px (1.6)** | 19/25 (GOV.UK), 18.4/27.6 (Wellcome), 19 (NHS), 17→21 fluid (Piccalilli) | На 2–3px мельче нижней границы отрасли. Это первопричина «выглядит хуже» |
| Цвет основного текста | **`#707070`** (`body { color: --color-gray-600 }`) — 5.0:1 | `#0b0c0c` (GOV.UK), `#121212` (Wellcome), `#1a1a1a` (старый ИКПК) | Серый основной текст — самый сильный сигнал «дешёвый шаблон». Мы серым красим **весь** body, а не только meta |
| Шкала | 7 фиксированных ступеней 0.75/0.875/1/1.125/1.25/1.5/**2.25rem** — дырка между 1.5 и 2.25, ничего fluid | 7–9 ступеней, fluid, база 17–19 | Нет ступеней 22, 26, 32; между h2 (24px) и h1 (36px) пустота; мобильная шкала не отличается от десктопной |
| Leading | `1.6` для всего, `1.3` для всех h1–h6 | 5 токенов leading: 1.0/1.1/1.2/1.3/1.4 | Заголовок 36px с leading 1.3 (=46.8px) «распадается»; крупному нужен 1.1–1.15 |
| Tracking | `normal` везде (кроме `.btn`: 0.01em) | −0.022em @64px (Linear), −0.02em @48px (Stripe), −0.015em (Piccalilli), −1.5% (MIT) | Отрицательного tracking нет вообще. Это главное отличие «набрано» от «поставлено дефолтом» |
| Вес | h1–h6 все **600**; body 400 | 510/560/590/620 на variable-шрифте; вес **падает** с ростом кегля (Stripe 300@48, Linear 510@64) | Один вес 600 для 36px и для 18px. Inter у нас вариативный 400–700 ⇒ промежуточные веса уже оплачены и не используются |
| Ширина колонки | `.payment-content { max-width: 800px }` при кегле 16px = **≈100ch** | 620px (Wellcome), 65ch (Piccalilli), 672px (Cosmic), 616–864 (MIT) | На 35–50% шире комфортного. Для русского текста это ещё хуже, чем для латиницы |
| Число мер на странице | **три**: h1 1168px, highlight-карточка 700px, контент 800px | одна prose-мера + одна широкая | Отсюда «рваный» правый край |

### 2.2 Цвет, поверхности, контрасты

- **Поверхностей две**: `--color-light-100` (страница) и `--color-light-300` (`.section-alt`).
  У Radix — 5 ступеней фона, у Geist — 3. Нет `sunken`, нет `raised`, нет `inverse`.
  Следствие: белая карточка на белой странице держится только на границе 1px — как на скриншоте /oplata,
  где три аккордеона читаются как три пустые рамки.
- **Границ одна**: `--color-gray-200` используется и как разделитель, и как рамка карточки,
  и как рамка таблицы. У Radix это три разные ступени (6/7/8).
- **Нет токена фокуса вообще.** Замерено: фокус на `.topnav-link` и на `summary` —
  дефолтный `outline: rgb(0,95,204) auto 1px`. Синий системный ринг на зелёном бренд-сайте,
  толщиной 1px, без offset. У всех шести основных референсов фокус спроектирован
  (2–4.8px, с offset, часто двухслойный).
- **Зелёная рампа немонотонна**: `--color-accent-500: #357a38` **темнее**, чем
  `--color-accent-600: #338035`. Значит `.btn-primary:hover` (500→600) делает кнопку
  *светлее*, а по названию должен темнить. Про такую палитру нельзя рассуждать,
  и любое новое состояние придётся подбирать вручную.
- **Серые нейтральные**, без подмеса бренд-оттенка (`#707070`, `#b8b8b8`, `#e5e5e5`).
  У Linear серые синеватые, у Piccalilli тёплые. Чисто-нейтральный серый рядом с
  насыщенным зелёным читается как «грязный».
- **Ссылки синие** (`--color-info-500: #2f6fd0`) на зелёном бренд-сайте — цветовой конфликт,
  и он же порождает баг из §2.5.
- **Тёмная тема: карточки исчезают.** В тёмной теме `--color-light-100: #171a17` — это
  одновременно фон страницы (`body`) и фон карточки (`.card`). Тени при этом
  остались `rgba(0,0,0,.06)` — на тёмном они невидимы. То есть в dark-режиме
  карточка = невидимый прямоугольник с чуть заметной рамкой.

### 2.3 Ритм, глубина, состояния

- **Ритм секций плоский**: `.section { padding: 3rem 0 }` — 48px на всех вьюпортах
  и для всех типов секций. Внутренние отступы (24–40px) сопоставимы с секционными ⇒
  макро-ритма нет. У Piccalilli 10 ступеней отступов + 8 парных диапазонов, секционный
  fluid.
- **Шкалы отступов нет**: значения зашиты по месту (`0.25/0.5/0.75/1/1.25/1.5/2/2.5/3rem`
  вперемешку в семи файлах).
- **Радиусов два**: `--radius-s: 4px`, `--radius-m: 8px`. И 8px стоит **на всём** — на
  кнопке, на карточке, на дропдауне, на аккордеоне, на инпуте. Одинаковый радиус на
  контроле и на контейнере убивает иерархию. У Linear 7 ступеней, у Stripe контрол 6 / карточка 16.
- **Теней две, однослойные**: `--shadow-s: 0 2px 8px rgba(0,0,0,.06)`,
  `--shadow-m: 0 4px 12px rgba(0,0,0,.08)`. Ни одна не многослойная, обе чёрные,
  ни одной для «поднятого» состояния, ни одной цветной под CTA.
- **Состояния**: у `.card` в покое тени нет вообще (только на hover) ⇒ карточка не
  «лежит на поверхности», она нарисована. У `details[open]` меняется только шеврон —
  фон/поверхность не меняются, открытый пункт визуально не отличается от закрытого.
- **Таблицы** (`rich-content.css:103-119`): сетка 1px по **каждой** ячейке, паддинг
  `0.5rem 0.75rem`, `th` на `--color-light-300`. Это визуальный язык Excel 2003.
  Референсы: только горизонтальные хайрлайны, `th` мелкий капсом с letter-spacing,
  паддинг 0.75–1rem, табличные цифры, скругление на обёртке.
- **Ссылки в контенте не подчёркнуты** (`a { text-decoration: none }`, подчёркивание
  только на hover) — и признак качества, и требование WCAG 1.4.1 (цвет как
  единственный различитель).
- **`scroll-margin-top` отсутствует.** При sticky-шапке 60px любая ссылка-анкор
  приводит на заголовок, спрятанный под навигацией.
- **Нет `::selection`.** Мелочь на 3 строки, но она в списке того, что отличает
  «дизайн» от «шаблона».
- **Motion без токенов**: `0.2s ease`, `0.15s`, `0.6s cubic-bezier(.16,1,.3,1)`
  прописаны по месту в `motion.css`. Слой сам по себе хороший (только transform/opacity,
  `prefers-reduced-motion`, гейт `.has-motion`) — не хватает именно токенов длительности и easing.

### 2.4 Что конкретно потеряли относительно старого сайта

Владелец сказал «/oplata выглядит хуже, контент не при чём» — он прав, и вот три причины
(значения замерены на `ikpk.su/oplata`):

1. **Спроектированную CTA-полосу заменили на серый текст с кнопкой.**
   Старый сайт: полоса на всю ширину контента,
   `background: linear-gradient(90deg, #41a143, #161616 54%)`, `border-radius: 20px`,
   `padding: 17px 36px`, заголовок слева, кнопка справа, у кнопки **цветное свечение**
   `box-shadow: rgba(65,161,67,.35) 0 4px 18px`.
   У нас на том же месте — два серых абзаца 16px (`#707070`) и маленькая кнопка,
   свисающие под аккордеонами без всякой рамки.
2. **H1 упал с 48px/60 (вес 500) до 36px/46.8 (вес 600)** и лишился окружения:
   на старом сайте он в верхней зоне с левым сайдбаром, у нас — голый на белом.
3. **Контентная колонка перестала занимать сетку.** Старый сайт: 957px контента
   при сайдбаре. У нас: 800px контента внутри 1168px контейнера, справа **368px пустоты**,
   и в неё ничего не поставлено, хотя `.content-sidebar-layout` (`layout.css:4`)
   с sticky-aside у нас уже есть и используется на статьях/семинарах.

Плюс структурный перекос: на 1528px высоты документа тёмно-зелёная newsletter-полоса
и почти-чёрный футер занимают ~40% — контентная зона выше выглядит «голодной».

### 2.5 Три настоящих бага (не вкусовщина)

Их надо закрыть отдельно и раньше редизайна. По правилу проекта — сначала падающий тест.

1. **CTA `Произвести оплату` на /oplata: синий текст на зелёной кнопке.**
   Замерено: `color: rgb(47,111,208)` на `background-color: rgb(53,122,56)` — контраст
   **≈1.08:1** (относительные яркости 0.165 и 0.150 почти совпадают). Текст на кнопке
   практически не виден.
   Причина: `.rich-content a { color: var(--color-info-500) }`
   (`web/src/styles/rich-content.css:34-36`) имеет специфичность (0,1,1) против
   `.btn-primary` (0,1,0), и вдобавок `rich-content.css` импортируется **после**
   `utilities.css` в `global.css`. Любая кнопка, приехавшая из `body_html`, ломается так же.
   Фикс: сузить правило до `.rich-content a:not([class])` (безопасно для Safari 14).
   Это, скорее всего, и есть главная причина фразы «выглядит хуже старого сайта».
2. **Нет спроектированного фокус-ринга** — везде системный `outline: auto 1px` синим.
3. **`scroll-margin-top` не задан** при sticky-шапке 60px ⇒ анкоры уводят заголовок под навигацию.

И один дефект тёмной темы: `--surface` карточки равен `--surface` страницы (§2.2).

---

## 3. Спецификация токенов

Готово к переносу в `web/src/styles/tokens.css`. Все значения проверены на поддержку
Safari 14 (см. §5). Fluid-функции считаны на опорных точках вьюпорта **320px → 1280px**
и записаны в `vw` (не `vi`).

### 3.1 Шкала кегля (fluid)

```css
:root {
  /* 13→14 */ --step--2: clamp(0.8125rem, 0.7917rem + 0.1042vw, 0.875rem);
  /* 14→16 */ --step--1: clamp(0.875rem,  0.8333rem + 0.2083vw, 1rem);
  /* 17→19 */ --step-0:  clamp(1.0625rem, 1.0208rem + 0.2083vw, 1.1875rem);
  /* 19→22 */ --step-1:  clamp(1.1875rem, 1.125rem  + 0.3125vw, 1.375rem);
  /* 21→26 */ --step-2:  clamp(1.3125rem, 1.2083rem + 0.5208vw, 1.625rem);
  /* 24→32 */ --step-3:  clamp(1.5rem,    1.3333rem + 0.8333vw, 2rem);
  /* 30→44 */ --step-4:  clamp(1.875rem,  1.5833rem + 1.4583vw, 2.75rem);
  /* 36→60 */ --step-5:  clamp(2.25rem,   1.75rem   + 2.5vw,    3.75rem);
}
```

Назначение: `--step-0` — основной текст (заменяет 16px), `--step--1` — meta/подписи/`th`/кнопки,
`--step--2` — юридический мелкий шрифт, `--step-1` — лид-абзац и `summary` аккордеона,
`--step-2` — h3, `--step-3` — h2 и заголовки секций, `--step-4` — h1 страницы,
`--step-5` — hero главной. Старые `--font-xs…--font-xxxl` оставить алиасами на один релиз.

### 3.2 Leading и tracking

```css
:root {
  --leading-flat:   1;      /* display 60px */
  --leading-fine:   1.08;   /* 44–60px */
  --leading-tight:  1.15;   /* h1 */
  --leading-snug:   1.25;   /* h2, h3 */
  --leading-normal: 1.4;    /* h4, UI, лид */
  --leading-prose:  1.65;   /* основной текст */
  --leading-loose:  1.75;   /* мелкий шрифт */

  --tracking-display: -0.018em;  /* --step-5 */
  --tracking-tight:   -0.014em;  /* --step-4 */
  --tracking-snug:    -0.010em;  /* --step-3 */
  --tracking-normal:   0;
  --tracking-caps:     0.075em;  /* eyebrow / th uppercase */
}
```

**Важно про кириллицу.** Референсы дают −0.022em на 64px (Linear) и −0.02em на 48px (Stripe),
но это латиница. Кириллица плотнее и без верхних выносных, поэтому агрессивный минус
слепляет строки вроде «Институт клинической прикладной кинезиологии». Значения выше —
сознательно мягче референсов (−0.014 против −0.02 на h1). **Требует проверки глазами**
на самых длинных заголовках каталога перед фиксацией.

### 3.3 Веса (Inter variable 400–700, уже загружен)

```css
:root {
  --weight-body:    400;
  --weight-medium:  500;
  --weight-display: 560;  /* --step-4 / --step-5: крупнее ⇒ легче */
  --weight-heading: 620;  /* h2, h3, summary, кнопки */
  --weight-strong:  700;  /* акценты внутри текста */
}
```

Правило, которого сейчас нет: **чем крупнее кегль, тем меньше вес**. h1 переходит
с 36px/600 на ~44px/560. Промежуточные веса ничего не стоят — шрифт вариативный.

### 3.4 Шкала отступов

```css
:root {
  --space-3xs: 0.25rem;  /*  4 */
  --space-2xs: 0.5rem;   /*  8 */
  --space-xs:  0.75rem;  /* 12 */
  --space-s:   1rem;     /* 16 */
  --space-m:   1.5rem;   /* 24 */
  --space-l:   2rem;     /* 32 */
  --space-xl:  3rem;     /* 48 */
  --space-2xl: 4rem;     /* 64 */
  --space-3xl: 6rem;     /* 96 */

  /* fluid, для ритма секций */
  --space-section:       clamp(3rem, 2rem     + 5vw,     6rem);   /* 48→96  */
  --space-section-tight: clamp(2rem, 1.333rem + 3.333vw, 4rem);   /* 32→64  */
  --space-section-hero:  clamp(4rem, 2.667rem + 6.667vw, 8rem);   /* 64→128 */
  --space-block:         clamp(2rem, 1.667rem + 1.667vw, 3rem);   /* 32→48  */

  /* поток внутри prose */
  --flow:        var(--space-m);   /* абзац → абзац: 24 */
  --flow-tight:  var(--space-2xs);
  --flow-heading: clamp(2rem, 1.667rem + 1.667vw, 3rem); /* до h2: 32→48 */
}
```

### 3.5 Ширины и мера

```css
:root {
  --wrapper:        1200px;  /* как сейчас */
  --wrapper-wide:   1440px;
  --wrapper-narrow: 880px;
  --wrapper-gutter: clamp(1rem, 0.5rem + 2.5vw, 2rem);  /* 16→48, вместо жёстких 16 */

  --measure:        64ch;  /* prose. При --step-0 ≈ 640–660px на кириллице */
  --measure-narrow: 46ch;  /* лид, врезки */
  --measure-wide:   76ch;  /* таблицы, код */
  --measure-title:  24ch;  /* h1 — переносим сознательно, а не как выйдет */
}
```

`64ch`, а не `65–68ch` как у Piccalilli: `ch` считается по ширине «0», а кириллические
буквы в среднем шире латинских, поэтому одна и та же величина в `ch` даёт для русского
более широкую фактическую колонку.

### 3.6 Радиусы

```css
:root {
  --radius-xs:   2px;    /* бейджи-квадраты, чекбоксы */
  --radius-s:    6px;    /* кнопки, инпуты, пункты дропдауна */
  --radius-m:   10px;    /* картинки, мелкие плашки */
  --radius-l:   14px;    /* карточки, аккордеон-группа, обёртка таблицы */
  --radius-xl:  20px;    /* CTA-полоса, hero-визуал */
  --radius-pill: 999px;  /* статус-бейджи, чипы */
}
```

Смысл в **разнице между контролом и контейнером** (6 vs 14). Сейчас и там и там 8px.
20px на CTA-полосе — то же значение, что на старом сайте: сходство здесь уместно.

### 3.7 Тени (многослойные, тонированные в бренд)

```css
:root {
  /* тонирование: тёмно-зелёный вместо чистого чёрного */
  --shadow-xs: 0 1px 2px rgba(20, 38, 22, 0.06);
  --shadow-s:  0 1px 2px rgba(20, 38, 22, 0.05),
               0 2px 6px rgba(20, 38, 22, 0.05);
  --shadow-m:  0 2px 4px rgba(20, 38, 22, 0.04),
               0 6px 16px -4px rgba(20, 38, 22, 0.08);
  --shadow-l:  0 4px 8px -2px rgba(20, 38, 22, 0.05),
               0 16px 32px -8px rgba(20, 38, 22, 0.10);
  --shadow-xl: 0 8px 16px -4px rgba(20, 38, 22, 0.06),
               0 28px 56px -16px rgba(20, 38, 22, 0.14);

  /* цветное свечение под главным CTA — было на старом сайте, потеряно */
  --shadow-cta:       0 6px 20px -6px rgba(53, 122, 56, 0.45);
  --shadow-cta-hover: 0 10px 28px -8px rgba(53, 122, 56, 0.55);

  --shadow-hairline: inset 0 0 0 1px rgba(20, 38, 22, 0.06);
  --shadow-ring:     0 0 0 3px rgba(53, 122, 56, 0.28);
}

:root[data-theme='dark'] {
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-s:  0 1px 2px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.35);
  --shadow-m:  0 2px 4px rgba(0, 0, 0, 0.3),  0 8px 24px -6px rgba(0, 0, 0, 0.45);
  --shadow-l:  0 4px 8px rgba(0, 0, 0, 0.35), 0 20px 40px -10px rgba(0, 0, 0, 0.55);
  --shadow-xl: 0 8px 16px rgba(0, 0, 0, 0.4), 0 32px 64px -16px rgba(0, 0, 0, 0.6);
  /* в тёмной теме подъём читается верхним внутренним блеском, не тенью */
  --shadow-hairline: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
```

Опционально (по образцу Linear `--shadow-stack-low`), для чипов/бейджей — стек микрослоёв:
`0 3px 2px rgba(20,38,22,.03), 0 1px 1px rgba(20,38,22,.05), 0 0 1px rgba(20,38,22,.05)`.

### 3.8 Палитра: монотонная рампа + нейтральные с бренд-подмесом

`--color-accent-500: #357a38` сохраняется как якорь бренда (белый текст на нём — 5.26:1, AA).
Остальное перестраивается монотонно, чтобы `500 → 600 → 700` реально темнело:

```css
:root {
  --green-50:  #eff6ef;
  --green-100: #d6e8d7;
  --green-200: #aacfac;
  --green-300: #7cb480;
  --green-400: #4d9450;
  --green-500: #357a38;  /* бренд-якорь; #fff на нём = 5.26:1 */
  --green-600: #2b6630;
  --green-700: #225227;  /* на белом 6.9:1 — рабочий цвет ссылки */
  --green-800: #193e1d;
  --green-900: #102a13;
  --green-950: #08160a;

  /* нейтральные с ~3% зелёного подмеса — «одна семья» с акцентом */
  --gray-25:  #fafbfa;
  --gray-50:  #f5f7f5;
  --gray-100: #eceeec;
  --gray-200: #dfe2df;
  --gray-300: #c8ccc8;
  --gray-400: #a4aaa4;
  --gray-500: #7d847d;  /* 3.84:1 — ТОЛЬКО декор/плейсхолдер, не текст */
  --gray-600: #5b625b;  /* 6.28:1 — meta */
  --gray-700: #434943;  /* 9.24:1 — основной текст */
  --gray-800: #2c312c;
  --gray-900: #1a1e1a;  /* заголовки */
  --gray-950: #101310;
}
```

### 3.9 Семантический слой (по модели Radix/Geist) — то, чего нет совсем

```css
:root {
  /* поверхности: 4 уровня вместо 2 */
  --surface-page:    #fff;
  --surface-subtle:  var(--gray-50);   /* полоса-секция, фон под карточками */
  --surface-sunken:  var(--gray-100);  /* «вдавленное»: код, открытый аккордеон */
  --surface-raised:  #fff;             /* карточка */
  --surface-inverse: var(--green-950);
  --surface-accent-subtle: var(--green-50);

  /* границы: 3 уровня вместо 1 */
  --border-subtle:  var(--gray-100);  /* разделители, хайрлайны таблицы */
  --border-default: var(--gray-200);  /* рамка карточки */
  --border-strong:  var(--gray-300);  /* инпут, интерактивная рамка */
  --border-accent:  var(--green-500);

  /* текст: 4 уровня */
  --text-primary:   var(--gray-900);
  --text-body:      var(--gray-700);  /* ЗАМЕНА #707070 — главный фикс */
  --text-muted:     var(--gray-600);
  --text-faint:     var(--gray-500);  /* только не-текстовые роли */
  --text-on-accent: #fff;
  --text-link:      var(--green-700);
  --text-link-hover: var(--green-800);

  /* фокус */
  --focus-ring:          var(--green-600);
  --focus-ring-contrast: var(--surface-page);
  --focus-ring-width:    2px;
  --focus-ring-offset:   2px;
}

:root[data-theme='dark'] {
  --surface-page:    var(--gray-950);  /* #101310 */
  --surface-subtle:  #161a16;
  --surface-sunken:  #0c0f0c;
  --surface-raised:  #1a1e1a;          /* СВЕТЛЕЕ страницы — фикс исчезающих карточек */
  --surface-inverse: var(--gray-50);
  --surface-accent-subtle: #1c2a1d;

  --border-subtle:  #262b26;
  --border-default: #333a33;
  --border-strong:  #485048;

  --text-primary: #eceeec;
  --text-body:    #c4cac4;
  --text-muted:   #9aa19a;
  --text-faint:   #7a827a;
  --text-link:    #8fc593;
  --focus-ring:   #8fc593;
}
```

`--color-info-500` остаётся только для инфо-плашек. Ссылки в контенте переходят на
`--text-link` (зелёный) — синяя ссылка на зелёном бренд-сайте была цветовым конфликтом
и источником бага §2.5.1.

### 3.10 Motion

```css
:root {
  --dur-instant: 80ms;
  --dur-fast:    140ms;
  --dur-base:    220ms;
  --dur-slow:    400ms;
  --dur-reveal:  600ms;

  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);   /* уже используется в motion.css */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-in-out:   cubic-bezier(0.4, 0, 0.2, 1);
}
```

Существующая логика `motion.css` (только `transform`/`opacity`, гейт `.has-motion`,
`prefers-reduced-motion`, LCP-заголовок без `opacity`) — правильная, её не трогаем,
только подставляем токены вместо литералов.

---

## 4. Спецификация компонентов

### 4.1 `PageHeader` — новый компонент, главный рычаг

Это то, из-за отсутствия чего /oplata выглядит незакончённой, и это чинит все 260 страниц
одним движением.

```css
.page-header {
  background: linear-gradient(180deg, var(--surface-subtle) 0%, var(--surface-page) 100%);
  border-bottom: 1px solid var(--border-subtle);
  padding-top: var(--space-section);
  padding-bottom: var(--space-xl);
  margin-bottom: var(--space-section-tight);
}
.page-header__breadcrumbs { font-size: var(--step--1); color: var(--text-muted);
  margin-bottom: var(--space-m); }
.page-header__eyebrow {                 /* «Информация», «Обучение», «Семинар» */
  font-size: var(--step--1); font-weight: var(--weight-heading);
  text-transform: uppercase; letter-spacing: var(--tracking-caps);
  color: var(--green-700); margin-bottom: var(--space-xs);
}
.page-header__title {
  font-size: var(--step-4); line-height: var(--leading-tight);
  letter-spacing: var(--tracking-tight); font-weight: var(--weight-display);
  color: var(--text-primary); max-width: var(--measure-title);
}
.page-header__lede {
  font-size: var(--step-1); line-height: var(--leading-normal);
  color: var(--text-body); max-width: var(--measure-narrow);
  margin-top: var(--space-m);
}
.page-header__meta {                    /* чипы-факты: телефон, часы, город, цена */
  display: flex; flex-wrap: wrap; gap: var(--space-xs);
  margin-top: var(--space-l); font-size: var(--step--1);
}
@supports (text-wrap: balance) { .page-header__title { text-wrap: balance; } }
```

### 4.2 Ритм секций и полосы

```css
.section       { padding-top: var(--space-section);       padding-bottom: var(--space-section); }
.section--tight{ padding-top: var(--space-section-tight); padding-bottom: var(--space-section-tight); }
.section--hero { padding-top: var(--space-section-hero);  padding-bottom: var(--space-section-hero); }

.section--subtle  { background: var(--surface-subtle); }
.section--inverse { background: var(--surface-inverse); color: var(--text-on-accent); }
/* хайрлайн между однотипными секциями на контентных страницах */
.section + .section:not([class*='--']) { border-top: 1px solid var(--border-subtle); }

.section__header { margin-bottom: var(--space-l); }
.section__eyebrow { /* как .page-header__eyebrow */ }
.section__title {
  font-size: var(--step-3); line-height: var(--leading-snug);
  letter-spacing: var(--tracking-snug); font-weight: var(--weight-heading);
  color: var(--text-primary);
}
```

Чередование фонов: `page → subtle → page → subtle → inverse(CTA/newsletter)`.
Сейчас `.section-alt` — единственный вариант и он плоский `#fafafa`.

### 4.3 `prose` (замена `.rich-content`)

```css
.prose {
  max-width: var(--measure);
  font-size: var(--step-0);
  line-height: var(--leading-prose);
  color: var(--text-body);
}
.prose > * + *        { margin-top: var(--flow); }
.prose > * + :is(h2, h3) { margin-top: var(--flow-heading); }

.prose :is(h2, h3, h4) {
  color: var(--text-primary);
  scroll-margin-top: calc(var(--header-height) + var(--space-m));  /* фикс анкоров */
}
.prose h2 { font-size: var(--step-3); line-height: var(--leading-snug);
  letter-spacing: var(--tracking-snug); font-weight: var(--weight-heading);
  margin-bottom: var(--space-xs); }
.prose h3 { font-size: var(--step-2); line-height: var(--leading-snug);
  font-weight: var(--weight-heading); margin-bottom: var(--space-2xs); }
.prose h4 { font-size: var(--step-1); line-height: var(--leading-normal);
  font-weight: var(--weight-heading); }

/* первый абзац как лид */
.prose > p:first-of-type { font-size: var(--step-1); color: var(--text-primary);
  line-height: var(--leading-normal); }

/* ссылки в тексте — всегда подчёркнуты */
.prose a:not([class]) {
  color: var(--text-link);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
  text-decoration-color: rgba(34, 82, 39, 0.4);
}
.prose a:not([class]):hover {
  color: var(--text-link-hover);
  text-decoration-thickness: 2px;
  text-decoration-color: currentColor;
}

.prose :is(ul, ol) { padding-left: 1.35em; }
.prose li + li     { margin-top: var(--space-2xs); }
.prose li::marker  { color: var(--green-500); }

.prose blockquote {
  border-left: 3px solid var(--border-accent);
  padding-left: var(--space-m);
  font-size: var(--step-1);
  color: var(--text-primary);
  font-style: normal;          /* курсив на кириллице читается хуже */
}
.prose img { border-radius: var(--radius-m); box-shadow: var(--shadow-s);
  margin-top: var(--space-l); margin-bottom: var(--space-l); }
.prose hr  { border: 0; border-top: 1px solid var(--border-subtle);
  margin-top: var(--space-xl); margin-bottom: var(--space-xl); }
.prose strong { color: var(--text-primary); font-weight: var(--weight-strong); }
```

### 4.4 Таблицы

```css
.prose .table-wrap {
  overflow-x: auto; -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-l);
  background: var(--surface-raised);
  box-shadow: var(--shadow-xs);
  margin-top: var(--space-l); margin-bottom: var(--space-l);
}
.prose table { width: 100%; border-collapse: collapse; border: 0;
  font-variant-numeric: tabular-nums; }
.prose th {
  font-size: var(--step--1); font-weight: var(--weight-heading);
  text-transform: uppercase; letter-spacing: var(--tracking-caps);
  color: var(--text-muted); text-align: left; background: transparent;
  padding: var(--space-xs) var(--space-s);
  border: 0; border-bottom: 1px solid var(--border-default);
  white-space: nowrap;
}
.prose td {
  padding: var(--space-s);
  border: 0; border-bottom: 1px solid var(--border-subtle);
  color: var(--text-body); vertical-align: top;
}
.prose tbody tr:last-child td { border-bottom: 0; }
.prose tbody tr:hover td      { background: var(--surface-subtle); }
.prose :is(th, td):first-child { padding-left: var(--space-m); }
.prose :is(th, td):last-child  { padding-right: var(--space-m); }
.prose td[data-numeric], .prose th[data-numeric] { text-align: right; }
```

Ключевое: **вертикальных линеек нет**, `th` — мелкий капс, цифры табличные,
скругление живёт на обёртке, а `overflow: hidden` не нужен, потому что `border` только у обёртки.

### 4.5 Аккордеон (группа `<details>`)

```css
.accordion {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-l);
  background: var(--surface-raised);
  box-shadow: var(--shadow-xs);
  overflow: hidden;               /* чтобы хайрлайны сходились со скруглением */
}
.accordion > details + details { border-top: 1px solid var(--border-subtle); }
.accordion > details[open]     { background: var(--surface-subtle); }

.accordion summary {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-m);
  min-height: 60px;
  padding: var(--space-s) var(--space-m);
  font-size: var(--step-1); font-weight: var(--weight-heading);
  color: var(--text-primary); cursor: pointer; list-style: none;
  transition: background-color var(--dur-fast) var(--ease-standard),
              box-shadow var(--dur-fast) var(--ease-standard);
}
.accordion summary::-webkit-details-marker { display: none; }
.accordion summary:hover {
  background: var(--surface-subtle);
  box-shadow: inset 3px 0 0 var(--green-500);   /* акцентная планка — дешёвый сигнал */
}
/* маркер +/− в круге вместо тонкого шеврона */
.accordion summary::after {
  content: ''; flex: none; width: 28px; height: 28px;
  border-radius: var(--radius-pill);
  background: var(--surface-accent-subtle);
  /* два штриха плюса — через background-image, без лишней разметки */
  background-image:
    linear-gradient(var(--green-700), var(--green-700)),
    linear-gradient(var(--green-700), var(--green-700));
  background-size: 12px 2px, 2px 12px;
  background-position: center, center;
  background-repeat: no-repeat;
  transition: transform var(--dur-base) var(--ease-out);
}
.accordion details[open] summary::after { transform: rotate(45deg); }
.accordion details[open] summary { border-bottom: 1px solid var(--border-subtle); }
.accordion .accordion__body { padding: var(--space-m); max-width: var(--measure); }
```

Сейчас у открытого пункта меняется только шеврон, фон не меняется вообще.

### 4.6 Карточки

```css
.card {
  background: var(--surface-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-xs);          /* тень В ПОКОЕ, не только на hover */
  transition: transform var(--dur-base) var(--ease-out),
              box-shadow var(--dur-base) var(--ease-out),
              border-color var(--dur-base) var(--ease-out);
}
@media (hover: hover) {
  .card:hover {
    transform: translateY(-2px);          /* было -4px: для медицины спокойнее */
    box-shadow: var(--shadow-m);
    border-color: var(--green-200);
  }
}
.card__body { padding: var(--space-m); }
.card--flat { box-shadow: none; }         /* для карточек на .section--subtle */
```

### 4.7 Кнопки

```css
:root { --control-h-s: 36px; --control-h-m: 44px; --control-h-l: 52px; }

.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--space-2xs);
  min-height: var(--control-h-m);          /* было ~37px; 44px = WCAG 2.5.8 */
  padding: 0 var(--space-m);
  font-size: var(--step--1); font-weight: var(--weight-heading);
  letter-spacing: 0.005em; line-height: 1.2;
  border: 1px solid transparent; border-radius: var(--radius-s);
  cursor: pointer; text-decoration: none;
  transition: background-color var(--dur-fast) var(--ease-standard),
              box-shadow var(--dur-fast) var(--ease-standard),
              transform var(--dur-instant) var(--ease-standard);
}
.btn--l { min-height: var(--control-h-l); padding: 0 var(--space-l);
          font-size: var(--step-0); }
.btn--s { min-height: var(--control-h-s); padding: 0 var(--space-s); }

.btn-primary {
  background: linear-gradient(180deg, var(--green-500) 0%, var(--green-600) 100%);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-cta), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.btn-primary:hover {
  background: linear-gradient(180deg, var(--green-600) 0%, var(--green-700) 100%);
  box-shadow: var(--shadow-cta-hover), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  transform: translateY(-1px);
}
.btn-primary:active { transform: translateY(0); box-shadow: var(--shadow-xs); }

.btn-outline {
  background: var(--surface-page); color: var(--green-700);
  border-color: var(--border-strong); box-shadow: var(--shadow-xs);
}
.btn-outline:hover { background: var(--surface-accent-subtle);
  border-color: var(--green-400); color: var(--green-800); }
```

Три отличия от текущего: вертикальный градиент + внутренний верхний блеск (кнопка
перестаёт быть плоским прямоугольником), **цветное свечение** `--shadow-cta`
(было на старом сайте, потеряно), высота 44px вместо 37px.

### 4.8 CTA-полоса — восстановление потерянного блока

```css
.cta-band {
  position: relative; overflow: hidden;
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-l); align-items: center;
  padding: clamp(1.5rem, 1.17rem + 1.67vw, 2.5rem)
           clamp(1.5rem, 0.83rem + 3.33vw, 3.5rem);
  border-radius: var(--radius-xl);
  background: linear-gradient(100deg, var(--green-700) 0%, var(--green-950) 62%);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-l);
}
/* один радиальный блик — самый дешёвый способ сделать плоский градиент «сделанным» */
.cta-band::before {
  content: ''; position: absolute; top: 0; right: 0; bottom: 0; left: 0;
  pointer-events: none;
  background: radial-gradient(120% 140% at 8% 0%,
              rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0) 60%);
}
.cta-band__title { position: relative; font-size: var(--step-2);
  line-height: var(--leading-snug); font-weight: var(--weight-heading);
  color: var(--text-on-accent); }
.cta-band__text  { position: relative; font-size: var(--step-0);
  color: rgba(255, 255, 255, 0.78); margin-top: var(--space-2xs);
  max-width: var(--measure-narrow); }
.cta-band__action { position: relative; }
@media (max-width: 720px) {
  .cta-band { grid-template-columns: 1fr; }
}
```

Градиент по мотивам старого сайта (`linear-gradient(90deg,#41a143,#161616 54%)`),
но на бренд-токенах и с бликом. `position: relative` у детей нужен, потому что
`::before` перекрывает содержимое (`z-index` не требуется).

### 4.9 Фокус — единое правило с деградацией под Safari 14

```css
:where(a, button, summary, input, select, textarea, [tabindex]):focus {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: inherit;
}
@supports selector(:focus-visible) {
  :where(a, button, summary, input, select, textarea, [tabindex]):focus { outline: none; }
  :where(a, button, summary, input, select, textarea, [tabindex]):focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
}
/* на тёмных поверхностях — двойной ринг (приём MIT Sloan) */
.section--inverse :where(a, button):focus-visible,
.cta-band :where(a, button):focus-visible {
  outline-color: #fff;
  box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.45);
}
```

Safari 14.0 не знает `@supports selector()` ⇒ блок целиком пропускается и остаётся
базовый `:focus`-ринг. Деградация в **безопасную** сторону: ринг виден всегда,
включая клик мышью. Это шумнее, но доступно.

### 4.10 Бесплатная полировка (в сумме ~15 строк)

```css
::selection { background: var(--green-100); color: var(--green-900); }
:target     { scroll-margin-top: calc(var(--header-height) + var(--space-m)); }
:root       { font-variant-numeric: normal; }
.price, .date, .prose table { font-variant-numeric: tabular-nums; }
.card__title, .prose h2, .prose h3 { overflow-wrap: break-word; } /* длинные русские слова */
@supports (text-wrap: balance) { h1, h2, .card__title { text-wrap: balance; } }
@supports (hanging-punctuation: first) { .prose { hanging-punctuation: first; } }
```

**Проверить перед использованием:** `font-feature-settings: 'ss03', 'cv05'` (альтернативные
глифы Inter) — в проекте не используется нигде, и надо убедиться, что при сборке сабсетов
`public/fonts/inter-*.woff2` (48.4 KB латиница, 18.7 KB кириллица) OpenType-фичи не
вырезаны. Если сохранились — это ещё один бесплатный шаг качества.

### 4.11 Заполнить пустую правую колонку

На /oplata справа 368px пустоты. Инфраструктура уже есть — `.content-sidebar-layout`
(`web/src/styles/layout.css:4`) со sticky-aside, применяется на статьях и семинарах.
Контентные страницы (`oplata`, `kontakty`, информационные) надо перевести на неё:
слева `prose` на `--measure`, справа sticky-карточка «Вопросы по оплате» (сейчас она
растянута плашкой на 700px в потоке) + «Записаться» + ближайшие даты.
Это не новый CSS, это применение существующего.

---

## 5. Ограничения: Safari 14 и бюджеты

### 5.1 Что нельзя (обязательный вид), и что можно только как улучшение

Целевые браузеры зафиксированы в `web/astro.config.mjs`
(`vite.build.cssTarget: ['chrome90','edge90','firefox90','safari14']`).

**Не использовать в обязательном виде:**

| Фича | Safari с | Как обходим |
|---|---|---|
| `:has()` | 15.4 | запрещено брифом; в спецификации выше не встречается |
| `:focus-visible` | 15.4 | база на `:focus` + апгрейд в `@supports selector(:focus-visible)` (§4.9) |
| `color-mix()` | 16.2 | явные ступени палитры (§3.8) вместо смешивания на ходу |
| `oklch()` / `lab()` | 15.4 | hex-ступени |
| единица `lh` | 18 | `rem` / `em` |
| единицы `vi` / `vb` | 15.4 | **`vw`** — поэтому все `clamp()` в §3 переписаны с вывода Utopia |
| `aspect-ratio` | 15 | padding-hack, если понадобится |
| `@container` | 16 | медиазапросы |
| `inset` (shorthand) | 14.1 | `top/right/bottom/left` — так и записано в §4.8 |
| `padding-inline` / `margin-block` | 14.1 | физические свойства; в §3–4 логические не используются |
| `gap` во flexbox | 14.1 | уже используется в проекте (риск не новый); в grid `gap` безопасен |

**Только как прогрессивное улучшение (в `@supports`):** `text-wrap: balance` (17.4),
`hanging-punctuation` (Safari-only), `accent-color` (15.4), `scrollbar-gutter` (18.2).

Напоминание из существующего комментария в `astro.config.mjs`: пин `cssTarget` — несущий.
lightningcss при других таргетах переписывает медиазапросы в range-синтаксис и на
старых iOS **все** брейкпоинты молча отключаются. Playwright это не ловит.

### 5.2 Цена в килобайтах

Замеренная база: `dist/_astro/global.Dy-HHyNm.css` = **20 932 B** минифицированного CSS;
средняя HTML-страница = **45 811 B**; страниц 260.

| Блок | raw | ≈gzip |
|---|---|---|
| Слой токенов (§3): ~90 свойств вместо ~30 | +2.2 KB | +0.45 KB |
| `prose` + типографика (§4.3) | +2.5 KB | +0.50 KB |
| `PageHeader` (§4.1) | +1.2 KB | +0.30 KB |
| Таблицы, аккордеон, карточки, кнопки (§4.4–4.7) | +3.5 KB | +0.70 KB |
| CTA-полоса (§4.8) | +0.9 KB | +0.25 KB |
| Фокус, `::selection`, motion-токены (§4.9–4.10, §3.10) | +0.8 KB | +0.20 KB |
| **Итого** | **≈ +11 KB** | **≈ +2.4 KB** |

Это **один** общий stylesheet, кешируемый на все 260 страниц. Прирост HTML на страницу:
0 там, где разметка не меняется, и до +0.4 KB там, где добавляется обёртка `PageHeader`
с eyebrow. Нового JS — **ноль**.

Против бюджетов `web/lighthouserc.cjs` (perf ≥ 0.85, LCP ≤ 2500 мс, TBT ≤ 200 мс,
CLS ≤ 0.1, a11y ≥ 0.9, SEO ≥ 0.95):

- **TBT** — не меняется, JS не добавляется.
- **CLS** — не меняется: нет ничего, что меняет геометрию после загрузки; тема
  выставляется синхронно в `<head>`, `motion.css` двигает только `transform`/`opacity`.
- **FCP** — рендер-блокирующий CSS растёт на ~2.4 KB по проводу. На мобильном троттлинге
  Lighthouse это один лишний TCP-сегмент, порядка **+10…25 мс**.
- **LCP — единственная метрика, которую надо перепроверить.** На контентных страницах
  LCP-элемент это `h1`, а мы растим его с 36px до ~44px и ставим за ним градиентную
  полосу. Градиент — это отрисовка, а не сетевой запрос, так что запас большой,
  но LHCI на четырёх шаблонных URL надо перегнать сразу после посадки `PageHeader`.
- **A11y скорее вырастет**: контраст основного текста 5.0:1 → 9.2:1, спроектированный
  фокус-ринг вместо системного, подчёркнутые ссылки в тексте (WCAG 1.4.1),
  тач-таргет кнопок 37px → 44px (WCAG 2.5.8).

**Чего делать не надо:** добавлять второй (display) шрифт. Сабсет с кириллицей и
латиницей — это +20…35 KB woff2, и он становится рендер-блокирующим ровно на LCP-элементе.
Всё нужное «display-качество» достаём из вариативного Inter: веса 510/560/620 (уже
оплачены) плюс отрицательный tracking. Цена — 0 KB.

---

## 6. Порядок работ

| Волна | Содержание | Риск |
|---|---|---|
| **0. Баги** | §2.5: синий текст на зелёной кнопке (`rich-content.css:34` → `a:not([class])`); фокус-ринг; `scroll-margin-top`; `--surface-raised` ≠ `--surface-page` в тёмной теме. По правилу проекта — сначала падающий тест | низкий, эффект заметный сразу |
| **1. Токены** | §3 целиком. Старые `--font-*`, `--radius-*`, `--shadow-*` оставить алиасами на релиз. Главное изменение — `body { color: var(--text-body) }` вместо `#707070` и `--step-0` вместо 16px | средний: меняет вид **всех** 260 страниц. Нужен Playwright-скрин-байлайн до/после на 4 шаблонах × 3 ширины |
| **2. Каркас** | `PageHeader`, ритм секций и полосы, `prose`, фокус, `::selection`. Перегнать LHCI | средний |
| **3. Блоки** | Таблицы, аккордеоны, карточки, кнопки, CTA-полоса. Контентные страницы — на `.content-sidebar-layout` | низкий |
| **4. Доводка** | Паритет тёмной темы, перебаза LHCI, регресс-тесты вёрстки на 360/768/1280 | низкий |

Волна 1 — единственная, которая может выглядеть хуже до окончания волны 2:
крупный текст в узкой колонке без спроектированной шапки страницы выглядит незакончённо.
Волны 1 и 2 стоит выпускать одним PR.

Layout-баги в этом проекте ловятся только Playwright, а не build-гейтами, поэтому
скрин-байлайн до/после на 4 шаблонных URL из `lighthouserc.cjs` × 3 ширины — обязательная
часть волн 1 и 2.

---

## 7. Три направления под варианты мокапов

Добавлено 2026-07-26 по требованию владельца: изменения внешнего вида сначала показываются
мокапами страниц в вариантах. Токены §3 и компоненты §4 — **общий фундамент всех трёх**
(шкала кегля, семантический слой цвета, фокус, исправление §2.5). Направления расходятся
только значениями из §7.2 — то есть один PR инфраструктуры, три тонких слоя поверх.

### 7.0 Что реально лежит на /oplata (замерено после наполнения)

Прежде чем разводить направления — фактический объём, потому что он ограничивает варианты.
Замер локальной `/oplata` с принудительно раскрытыми `details`:

| Панель | Знаков | Структура |
|---|---|---|
| Как оплатить? | 211 | 2 нумерованных шага: подать заявку → менеджер свяжется |
| Способы оплаты? | 676 | вступление + **2** способа (наличные с адресом офиса; карта через ЮKassa) + список платёжных систем (Visa, Mastercard, Maestro, Мир, JCB; АПРА, БЕЛКАРТ, Корти Милли, Express Pay) |
| Условия возврата | 250 | один абзац юридического текста |
| **Всего prose** | **≈1 340** | высота документа 2 206px |

Три вывода, обязательных для всех трёх направлений:

1. **Аккордеон здесь — антипаттерн.** 1 340 знаков спрятаны за три клика, и каждая панель
   короче экрана. Направления A и B показываем **полностью раскрытым текстом** с `h2`
   вместо `summary`; аккордеон остаётся только в направлении C — тогда владелец увидит
   разницу и выберет осознанно.
2. **Сетка из 3–4 карточек будет выглядеть раздутой** — шагов всего 2, способов всего 2.
   Карточные плитки допустимы только для платёжных систем (там 9 позиций).
3. **Правильная геометрия — узкая колонка + заполненный правый sticky-aside**, а не
   широкий контент. Адрес офиса, часы работы, телефон, CTA «Записаться» — в aside.
   Механизм уже есть: `.content-sidebar-layout` (`web/src/styles/layout.css:4`).

### 7.1 Направления

#### A. «Клиника» — институциональная строгость
Референсные опоры: GOV.UK, NHS, MIT Sloan Exec Ed.

Идея: доверие берётся строгостью, а не украшениями. Почти нет скруглений, почти нет
теней; глубина — исключительно 1px-хайрлайны и смена поверхности. Акцентный зелёный —
дефицитный ресурс: только действие, активное состояние и маркеры. Всё остальное —
почти-чёрный по белому. Это направление читается как «серьёзное медучреждение,
которое не пытается никого продать».

Чем отличается: самый **сдержанный акцент** (~5% площади), самая **разреженная** сетка,
самая **спокойная типографика** (tracking почти нулевой, h1 не самый крупный).
Главный риск — «похоже на госуслуги»; лечится качеством отступов и хайрлайнов.

#### B. «Кафедра» — редакторско-академическое
Референсные опоры: Wellcome Collection, Piccalilli.

Идея: сайт как медицинский журнал. Ведёт типографика длинного текста: узкая колонка,
крупный лид-абзац, широкие поля, боковые заметки на полях, нумерация как в методичке.
Карточек почти нет — блоки разделяются пустотой и хайрлайнами. Акцент работает как
типографический инструмент: левая планка 3px у врезок, зелёные маркеры списков,
зелёные подчёркивания ссылок; заливок почти нет.

Чем отличается: самый **высокий типографический контраст** (h1 60px против body 19px),
самая **узкая колонка**, самый **воздушный** внутри текста и самый скупой на объекты.
Главный риск — на страницах-каталогах (расписание, 63 события) редакторская лёгкость
может рассыпаться в кашу; проверяется именно мокапом `/raspisanie-i-tseny`.

#### C. «Кит» — современный продуктовый шаблон
Референсные опоры: Stripe, Linear, Cosmic Themes.

Идея: ровно то, что владелец назвал «модный актуальный сайт» — то, как выглядят
коммерческие киты студий. Явные поверхности, ощутимая глубина, крупные скругления,
градиентные CTA-полосы, чипы-бейджи, всё смысловое — в карточках. Именно тут
восстанавливается потерянная CTA-полоса из §2.4 с цветным свечением под кнопкой.

Чем отличается: самая **плотная** сетка, самая **активная работа с акцентом**
(~18% площади: градиенты, заливки, чипы, свечения), полная **шкала теней** и
самые **крупные радиусы**. Главный риск — уехать в «модный стартап», что для
врачей контрпродуктивно; сдерживается тем, что зелёный тёмный и приглушённый
(`--green-700` → `--green-950`), а не кислотный, и что hover-подъём всего 2px.

### 7.2 Разведение по значениям — то, что кодируется в варианте

Всё остальное (палитра §3.8, семантика §3.9, фокус §4.9, шкала кегля §3.1) — общее.

| Ось | A «Клиника» | B «Кафедра» | C «Кит» |
|---|---|---|---|
| h1 | `--step-4` (30→44) / вес 620 / tracking −0.008em / leading 1.15 | `--step-5` (36→60) / вес 560 / −0.016em / leading 1.08 | `--step-4`↑ (32→48) / вес 560 / −0.014em / leading 1.12 |
| Основной текст | `--step-0` (17→19) / leading 1.60 | `--step-0` (17→19) / leading **1.70** | (16→18) / leading 1.60 |
| Лид-абзац | нет отдельного | `--step-1` (19→22), цвет `--text-primary` | `--step-0`, цвет `--text-body` |
| Мера prose | **62ch** | **58ch** + правое поле под заметки | **68ch** внутри карточки |
| Надзаголовок (eyebrow) | капс + `--tracking-caps`, без фона | нет — роль берёт лид | чип-pill: фон `--surface-accent-subtle`, `--radius-pill` |
| Отступ секций | `--space-3xl` (96) | `--space-2xl`…`3xl` (80) | `--space-2xl` (64) |
| Радиус контрол / контейнер | **2px / 4px** | **6px / 8px** | **8px / 16px**, полосы 24px |
| Тени | только `--shadow-xs` | `--shadow-xs`, `--shadow-s` | вся шкала `xs…l` + `--shadow-cta` |
| Разделение блоков | рамка 1px + смена поверхности | пустота + хайрлайн, рамок почти нет | рамка + тень + hover −2px |
| Площадь акцента | ~5% | ~8%, только линии и маркеры | ~18%, заливки и градиенты |
| Полосы секций | `--surface-subtle` (серый) | белый + хайрлайны | серый + **одна** `--section--inverse` градиентная |
| Главный CTA | плоская заливка, radius 4, без свечения | обводка + подчёркнутая ссылка рядом | градиент 180° + `--shadow-cta` + внутренний блеск |
| Таблица | хайрлайны, `th` капсом, без зебры | хайрлайны, без обёртки-рамки, крупный шрифт | обёртка `--radius-l` + тень, hover-строка |
| Аккордеон | **не используется** — текст раскрыт | **не используется** — текст раскрыт | группа `details` с маркером +/− (§4.5) |
| Иконки | 1.5px штрих, монохром `--text-muted` | почти нет | 2px штрих в зелёном кружке 28–40px |

### 7.3 Как каждое направление ложится на три страницы мокапов

**`/oplata`** (реальный объём ~1 340 знаков, см. §7.0)

- **A**: серая шапка страницы; «Порядок оплаты» — 2 крупных шага `01`/`02` с хайрлайнами
  между ними, номера почти-чёрные; «Способы оплаты» — таблица label/value без вертикальных
  линеек; платёжные системы — текстовым перечислением; «Условия возврата» — обычный
  раскрытый абзац под `h2`; адрес офиса — блок с левой границей 1px. Aside: контакты
  без заливки, только хайрлайн сверху.
- **B**: лид-абзац 22px почти-чёрным над всем; шаги — `ol` с крупными зелёными цифрами,
  вынесенными на левое поле; способы оплаты — `dl` (термин/описание); платёжные системы —
  инлайн-перечень через `·`; «Условия возврата» — врезка с левой планкой 3px как цитата
  из договора; адрес офиса — боковая заметка на правом поле. Aside: как продолжение полей,
  без рамки.
- **C**: шапка с чипом «Информация»; шаги — 2 карточки с иконками в зелёных кружках;
  способы оплаты — 2 карточки-плитки; платёжные системы — ряд pill-бейджей (9 штук —
  единственное место, где плитки оправданы объёмом); «Условия возврата» — аккордеон;
  внизу градиентная `.cta-band` с «Произвести оплату» и свечением. Aside: белая карточка
  с тенью, залипающая.

**Страница семинара**

- **A**: факты семинара (даты, город, преподаватель, цена, объём часов) — таблица
  label/value хайрлайнами; цена крупным почти-чёрным без плашки; одна кнопка;
  программа — плоский нумерованный список по дням.
- **B**: программа как редакторский текст по дням с крупными подзаголовками дней;
  преподаватель — портрет и биография в потоке текста, не в карточке; факты семинара
  вынесены на правое поле мелким кеглем.
- **C**: sticky-карточка записи справа (цена крупно, чипы «города», «часы», CTA с
  свечением); программа — аккордеон по дням; преподаватель — карточка с тенью и
  hover-подъёмом; ряд карточек «похожие семинары» внизу.

**`/raspisanie-i-tseny`** — здесь направления расходятся сильнее всего

- **A**: одна широкая таблица на `--measure-wide`, sticky `th`, зебры нет, только
  хайрлайны; зелёный — исключительно в бейдже статуса; фильтры — текстовые табы
  с подчёркиванием активного.
- **B**: сгруппировано по месяцам, крупный заголовок месяца `--step-3`, каждое событие —
  строка-запись с хайрлайном (дата слева мелким капсом, название крупнее, город и цена
  справа); карточек нет вообще. **Это направление тут под самым большим риском** —
  63 события без карточек могут читаться монотонно; мокап должен показать хотя бы 12
  событий, чтобы риск был виден.
- **C**: сетка карточек, у каждой блок даты слева (число крупно, месяц капсом),
  pill-бейджи статуса, hover-подъём; фильтры — чипы; наверху одна градиентная полоса
  «ближайший семинар».

### 7.4 Что нужно для честной оценки мокапов

- Каждый вариант — на **всех трёх** страницах, иначе выбор будет сделан по /oplata,
  а сломается на расписании.
- Каждый — минимум на **двух ширинах** (360 и 1280). Направление B на 360px теряет
  боковые поля и превращается в A — это надо увидеть до выбора, а не после.
- Мокапы делать **на реальном контенте**, включая самые длинные заголовки каталога:
  агрессивный отрицательный tracking (направления B и C) проверяется только на
  «Институт клинической прикладной кинезиологии» и подобных (§3.2).
- Тёмную тему в мокапах можно отложить, но `--surface-raised ≠ --surface-page`
  (§2.2, дефект исчезающих карточек) стоит починить до мокапов, иначе вариант C
  в тёмной теме нельзя оценить вообще.
- Баг §2.5.1 (синий текст на зелёной кнопке, контраст 1.08:1) починить **до** мокапов:
  иначе он попадёт во все три варианта и будет мешать сравнению.

---

## 8. Референсы заказчика: сверка с направлениями A/B/C

Добавлено 2026-07-26. Пять референсов от владельца с указанием «не копировать, взять принципы».
Оба дефекта из §2.5 к этому моменту исправлены (нечитаемый CTA, совпадение поверхностей в тёмной теме).

### 8.0 Что в них есть и что берём

| Референс | Проверено | Забираем | Не забираем |
|---|---|---|---|
| **Branksome Hall** / Takt<br>`https://takt.com/case-study/branksome-hall/` | Кейс: **шесть отдельных путей аудиторий** (поступающие семьи, ученики, сотрудники, выпускницы, доноры, сообщество), консолидация 450+ страниц и нескольких микросайтов в один сайт, модульная дизайн-система, WCAG 2.2 | Принцип: пути аудиторий — это **пере-архитектура ИА**, привязка сегмента к его мотивации и действиям. См. §8.5 | Школьный визуал; у нас нет ни донорского, ни alumni-сценария |
| **Wellesley College** / Fastspot<br>`https://www.fastspot.com/projects/wellesley-college` | **8 000+ страниц → 1 000** («88% smaller site», при этом «20% more page views», «72% engagement rate»). Названы модульные компоненты: **program cards, faculty profiles**. Витрина идентичности «We Are Wellesley» + «Wellesley 100» | Модульные компоненты как единицы системы; идея одной сильной витрины идентичности | **Само сокращение — см. §8.4: у нас обратная задача** |
| **IFM**<br>`https://www.ifm.org/education`, `/certification`, `/afmcp`, `/learning-center` | Разобран целиком через DevTools (WebFetch отдаёт 403). Body **18px/25.2**, h2 40/48/700, h3 32/38.4, контейнер 1200–1280, prose 660px | Больше всего — см. §8.2. Карточка каталога, 5 фасетов, скелет страницы курса, тарифная таблица, две ветки документов | Английские аббревиатуры; их «$0.00+» на бесплатном |
| **Real World CE**<br>`https://www.realworldce.org/` | H1 «Technology-focused CE built for real clinical practice». Ярлыки-надзаголовки капсом над каждым блоком: `PRINCIPLE`, `OUTCOME`, `BUILT BY EDUCATORS`, `DESIGNED FOR PRACTICE`, `ASSESSMENT-READY`. Сравнительная таблица «Traditional CE vs. Real World CE» (4 против 4). Триада `ENGAGEMENT / RETENTION / CONFIDENCE` | Ярлыки-надзаголовки; блок явно помеченный `OUTCOME`; таблица «до/после»; триада «пара слов + одна строка» | По прямому указанию владельца — SaaS-визуал: фейковое превью платформы, «MASTERY 66%», «Request a demo», glow-панели |
| **Reed College** / Carnegie<br>`https://www.carnegiehighered.com/work/reed-college/` | Кейс: люди Reed определены как отличительный атрибут; сайт строится на **storytelling студентов и преподавателей, отзывах и фотографии**; поддерживаемая дизайн-система | Принцип: организацию отличают люди, а не список услуг. Отзыв с полной атрибуцией | Фотография как несущий приём — см. §8.1, у нас её нет |

### 8.1 (а) Где референсы расходятся с A/B/C — и рекомендация

**Расхождение подтверждаю, и оно шире, чем одна фотография.** Три расхождения:

1. **Фотография людей как несущий приём.** У Branksome, Wellesley и Reed это первый визуальный приём.
   Ни в A, ни в B, ни в C фотография не несущая: все три решают типографику, поверхности и глубину.
2. **Пути аудиторий — это уровень ИА, а не визуала.** Шесть путей Branksome не «направление
   дизайна», их нельзя развести по вариантам `/preview/[variant]`: это структура сайта, общая
   для любого варианта. Разводить по вариантам можно только то, **как** входы в пути выглядят.
3. **Витрина идентичности.** У Wellesley это «We Are Wellesley», у Reed — storytelling.
   У нас на месте идентичности — три института и 27 преподавателей, и они нигде не собраны
   в один сильный блок.

#### Фотоинвентарь: «люди как главный образ» физически нереализуем

Замерено дважды независимо: мной по `web/public/media` через `sips` и лидом через `sharp`.
Числа лида точнее по портретам, поэтому ниже они.

**Вся медиатека — 343 файла с известными размерами:**

| Ширина | Файлов |
|---|---|
| **≥1600px** | **0** |
| 1000–1599px | 75 |
| 600–999px | 232 |
| <600px | 36 |

Самое широкое горизонтальное — **1280×720**, и это два превью YouTube
(`video-thumbs/34.jpg`, `37.jpg`). Следующие — **1200×675**, ровно 16:9 OG-картинки для
соцсетей, а не съёмка.

**Портреты преподавателей — 27 из 27 файлов есть, но:**

| Замер | Значение |
|---|---|
| Ориентация | **все 27 квадратные**; портретной ориентации **ноль** |
| Медиана ширины | **736px** |
| Максимум | 1200×1200 — таких **3** |
| Минимум | 220×220 |
| Файлов ≤600px | **9 из 27** (для крупной подачи негодны) |
| Вес: медиана / максимум / сумма | 48.9 KB / 288 KB / **1786 KB** |

**Отдельно: конвейера изображений в проекте нет.** Ни `astro:assets`, ни `<Image>`,
ни `sharp`, ни каталога `src/assets` — всё это `<img src>` из `public/` в нативном размере
(`src/components/home/sections/Teachers.astro:38`,
`src/components/institutes/InstituteTeacherCard.astro:15`). То есть портрет 736×736
отдаётся, чтобы отрисоваться на 120px. Это делает любую портретную сетку дорогой
**до** того, как она станет красивой (см. бюджет ниже).

#### Что из этого физически возможно: три ступени по размеру

При DPR 2 «резкий» показ = источник ÷ 2.

| Ступень | Показ | Годных файлов | Применение |
|---|---|---|---|
| **1** | **96–112px**, квадрат | **все 27** (худший 220px даёт 110px) | атрибуция: «кто ведёт», подпись автора статьи |
| **2** | до **300px**, квадрат | **18 из 27** (те, что >600px) | сетка преподавателей (уже есть на главной), карточка института |
| **3** | до **600px**, квадрат | **3 из 27** | компонент строить нельзя — не применится к остальным 24 |

Отсюда прямое исправление моей же спецификации из предыдущей версии этого раздела:
`.person-figure` при `clamp(120px, 14vw, 200px)` и соотношении **3:4** — **неверно
по двум пунктам**. Соотношение должно быть **1:1** (портретных источников нет вообще),
а верхняя граница — **144px**, а не 200px, иначе 9 файлов из 27 показываются
с растяжением. Верная спецификация — в §8.1.1.

**Попутно найденный дефект, прямо в портретных компонентах.** `aspect-ratio` уже
используется в проде: `Teachers.astro:63` (`aspect-ratio: 1 / 1`) и
`InstituteTeacherCard.astro:47` (`aspect-ratio: 1.14`). `aspect-ratio` — это Safari 15+,
а цель проекта Safari 14 (§5.1). В `InstituteTeacherCard` обёртка получает высоту
только из `aspect-ratio`, а `img` внутри — `height: 100%`; на Safari 14 высота обёртки
не вычисляется, и картинка может схлопнуться. Плюс `aspect-ratio: 1.14` на **квадратном**
источнике при `object-fit: cover` срезает ~12% по вертикали — то есть подстригает головы.
Оба пункта — в §8.4 к устранению.

#### Прямой ответ: реализуемость направлений без новой съёмки

| Направление | Реализуемо сейчас | Что требует НОВОЙ съёмки |
|---|---|---|
| **A «Клиника»** | **Да, полностью.** Изображений мало осознанно | ничего |
| **C «Кит»** | **Да, полностью.** Картинки живут внутри карточек при показе ≤400px; 75 файлов 1000–1599px и 232 файла 600–999px это покрывают. Единственная inverse-полоса — на градиенте, не на фото | ничего |
| **B «Кафедра»** | **Да — но не в том виде, как я её специфицировал.** Пилар «люди» надо понизить, см. ниже | портретная ориентация 3:4; портрет рядом с текстом в редакционном масштабе (≥400px показа); любое широкое фото выше ~1200px показа |
| Гипотетическое **четвёртое** «люди как главный образ» | **Нет. Не построить вообще** | полноэкранный герой (нужно 2400px+, есть 0 файлов даже на 1600), сюжетная съёмка залов и работы в парах |

**И честно, сверх вопроса:** приём Wellesley/Reed — это фотография людей **во всю ширину**.
Reed действительно ближе по смыслу (люди как отличительный атрибут), но на своём сайте
он тоже использует крупную съёмку. «Люди на масштабе портрета» — это компромисс,
который конструируем мы с тобой, а не то, что делает Reed. Поэтому:
**«люди как главный образ» нереализуемо сейчас ни в одном из трёх вариантов**,
и в мокапах его не должно быть даже намёком.

#### Рекомендация (та же, но по более сильной причине): три направления, B переименовать

Раньше я говорил «не вводить четвёртое, потому что его оценивали бы на плейсхолдерах».
С твоими числами причина жёстче: **четвёртое направление нельзя построить**, а не только
нельзя честно оценить. Ноль файлов ≥1600px — это не «мало материала», это отсутствие
материала.

**B переименовать из «Кафедра: люди и текст» в «B. Кафедра: текст и авторство»**
и понизить пилар людей с «люди как образ» до **«люди как атрибуция»**: портрет появляется
в масштабе подписи автора (96–144px, квадрат), а страницу несёт типографика.
Это не отговорка, а самостоятельная редакционная традиция — так устроены научные журналы
и авторские колонки: маленький портрет автора, крупный текст. И она реализуема
на сегодняшних ассетах на 100%.

##### 8.1.1 Исправленная спецификация пилара «авторство» (только направление B)

```css
/* Портрет-атрибуция: 1:1, все 27 файлов годны */
.person-figure {
  width: clamp(96px, 10vw, 144px);
  /* НЕ aspect-ratio — Safari 14. Квадрат держим padding-hack'ом */
}
.person-figure__frame { position: relative; height: 0; padding-bottom: 100%;
  overflow: hidden; border-radius: var(--radius-m);
  background: var(--surface-sunken); }        /* фон = LQIP, пока грузится */
.person-figure__frame img { position: absolute; top: 0; left: 0;
  width: 100%; height: 100%; object-fit: cover; }
.person-figure__name { font-size: var(--step--1); font-weight: var(--weight-heading); }
.person-figure__role { font-size: var(--step--2); color: var(--text-muted); }
```

- `.faculty-strip` — ряд 4–6 портретов **на ступени 1** (112px), под блоком «Кто ведёт».
- `.person-figure` в потоке текста — на правом/левом поле, 144px максимум.
- Сетка преподавателей на странице института — **ступень 2** (до 300px), и только
  для тех 18 файлов, что >600px; для остальных 9 — тот же 112px.
- **Никаких неквадратных рамок под квадратные источники** — это и есть текущий дефект
  `aspect-ratio: 1.14`.
- `.testimonial` с полной атрибуцией по образцу IFM («— Ridhwan Mokhtar, MD, 2026 AFMCP
  Graduate») остаётся в спецификации, но **текстов отзывов в данных нет** — §8.4, п. 3.

##### Бюджет портретов — прежде чем рисовать, надо переупаковать

Считаю на реальных байтах (медиана 48.9 KB, конвейера нет, отдаётся нативный размер):

| Сценарий | Сейчас | После переупаковки | Комментарий |
|---|---|---|---|
| `.faculty-strip`, 6 портретов на 112px | 6 × 48.9 ≈ **294 KB** | 128×128 webp ≈ 6 KB × 6 ≈ **36 KB** | −88% |
| Сетка 12 преподавателей на 300px | 12 × 48.9 ≈ **587 KB** | 320×320 webp ≈ 18 KB × 12 ≈ **216 KB** | обязательно `loading="lazy"` и ниже первого экрана |
| Все 27 на одной странице | **1786 KB** | ~**160 KB** на 128px | текущая цифра неприемлема при бюджете LCP 2500 мс |

Вывод: **переупаковка 27 портретов в набор 128/256/384 квадрат webp — предварительное
условие** для любого портретного UI, а не улучшение потом. Файлы лежат в `public/`,
поэтому Astro их не тронет: нужен либо перенос в `src/assets/` под `astro:assets`,
либо пред-сборочный скрипт. Это отдельная задача, и без неё пилар «авторство»
в направлении B удорожает страницу семинара примерно на 300 KB.

##### Что показывать в мокапах, чтобы оценка была честной

- **B**: реальные 27 портретов на ступени 1–2. Полноэкранного фотогероя нет.
  Вместо него — типографический герой + полоса атрибуции.
- **A и C**: по фотографии не менять.
- В каждом мокапе — видимая пометка, какие блоки ждут новой съёмки, чтобы владелец
  не оценивал пустое место как решение. Иначе он выберет вариант, а потом получит
  другой сайт.

### 8.2 (б) IFM: разбор и готовые решения

Самый полезный из пятёрки — согласен. Разобран через DevTools по четырём страницам.

#### Карточка каталога — ровно четыре строки, дата первой

```
AUG 3 - SEP 10, 2026                                  ← дата КАПСОМ, --step--1, --text-muted
GI Advanced Practice Modules (APM)                    ← название, --step-1
Restoring gastrointestinal (GI) equilibrium: …        ← ОДНО предложение-обещание
Online Cohort  |  $1,875.00+                          ← формат | цена, разделены «|»
```

Четыре приёма, которые надо забрать дословно:

1. **Дата — первый элемент карточки, до названия.** Не в подвале и не сбоку.
2. **Цена с суффиксом `+`** — честное «от», потому что есть добавки.
3. **Отсутствие цены не ломает раскладку**: у испаноязычных курсов IFM показывает только
   `Online Cohort` без черты и без цены. Прямо наш случай — часть из 50 событий имеет
   `newPrice: 0`.
4. **Когда даты нет — в её позиции стоит «Coming Soon»**, а цена и формат всё равно
   показываются. У нас в этой ситуации выводится «К сожалению, данный курс, в настоящий
   момент еще не запланирован» — извиняющаяся формулировка на месте, где должен быть
   статус. Все 115 семинаров в снапшоте `not_planned`, так что это самая частая строка сайта.
   Предлагаю: бейдж **«Дата уточняется»** + кнопка «Сообщить о наборе», а прозу убрать.

#### Пять фасетов фильтра (каждый — `<fieldset>` в аккордеоне)

`Certification` (входит ли в траекторию) · `Credits` (CME/CE) · `Free learning` ·
**`Level / Experience`: Foundational | Advanced** · `Access`: In-Person | Virtual |
Livestream | Online Cohort | On-Demand.
Сортировка: `Featured / Chronological / A-Z / Z-A / Price low-high / Price high-low`.
Счётчик результатов: «17 products found». Пагинация **URL-адресуемая** (`Page 1 / Page 2 /
Next / Last`), не бесконечный скролл — совпадает с задачей #12.

#### Перенос на `/raspisanie-i-tseny` (63 события) — фасеты только по тем полям, что есть

| Фасет | Наше поле | Значения в данных |
|---|---|---|
| **Институт** | `institute` | Апледжера 23, ИКПК 21, Барраля 6 |
| **Город / формат** | `city` + `additionalText` | СПб 30, Москва 17, Новосибирск 2, Онлайн 1; `additionalText: "Вебинар"` у 4 |
| **Уровень** ← аналог `Level / Experience` | вывести из кодов и названий | коды `ПК-N` (16), `ФПК-N` (14), `SER-N` (8), `КСТ-N` (8); «Уровень N» в названии у **53 из 115**; «Обязательное условие» у **48 из 115** ⇒ бинарное `Базовый / С предусловием` |
| **Объём** ← аналог `credit hours` | `duration` | 36 ч (27), 24 ч (10), 40 ч (7), 16 ч (3), 2 ч (1) |
| **Цена** | `newPrice` | 10 000 – 65 000 ₽; `oldPrice` всегда 0 ⇒ **поле мусорное, зачёркнутых цен не делать** |
| **Бесплатные** ← аналог `Free learning` | `isFree` | 1 из 50 |
| Сортировка | — | по дате (дефолт), по цене ↑↓, по названию |

Осознанно **не** делаю фасет по специальности — см. §8.5, там 80% пересечение.

Раскладка строки/карточки события под наши поля:
```
02 АПРЕЛЯ 2026                       ← дата, капс, --step--1
Тендинопатия: здоровье рук массажиста …
Фёдорова Т. В. · Институт клинической прикладной кинезиологии
Онлайн · 2 ч · Бесплатно            ← формат · объём · цена, разделители «·»
                                       [Записаться]  ← registrationFormLink есть у 49/50
```
`isEventCollection: true` у 10 из 50 — это сборные события, им нужен свой бейдж
(«цикл семинаров»), иначе они читаются как обычные и путают.

#### Скелет страницы курса IFM (`/afmcp`) — шапка и sticky-навигация

Шапка курса, порядок сверху вниз:
```
Course                                          ← тип, eyebrow
Applying Functional Medicine … (AFMCP)™         ← H1
Design effective, personalized treatments …     ← подзаголовок-обещание (у них это H2)
Online Cohort                                   ← формат
Oct 5 - Dec 17, 2026   [ADD TO CALENDAR]        ← даты + кнопка в календарь
Up to 39 credit hours                           ← объём
$3,015.00                                       ← цена
Eligible discounts applied at checkout          ← примечание про скидки
[Access Type ▾]  [CME/CE Credit ▾]              ← выбор варианта ПРЯМО в шапке
```

**Sticky-навигация по разделам страницы** — главный приём против «длинно и страшно»:
`Overview | What's Included | Who Should Attend | Educators/Presenters | Schedule |
Testimonials | CME/CE & PDH | Exhibit | Policies | FAQ`.

**Триада чисел** сразу после overview: `100% online` · `11 weeks to complete` ·
`39 credit hours`. У нас на это место просится `Санкт-Петербург` · `36 часов` ·
`3 дня, 10:00–18:00` (последнее есть в «Как проходит обучение» у 78 семинаров).

**Тарифная таблица** пятью строками: `Regular / IFM Member / Military-VA /
Student-Resident / **Group Rates**`. «Group Rates» — это ровно наш сценарий юрлица
(§8.5), у IFM он первоклассная строка прайса, а у нас спрятан в FAQ.

**Две ветки документов** (`/certification`): FMCP для лицензированных специалистов и
FMCP-M для врачей, NP, PA — «Eligibility for each credential is based on the practitioner's
highest level of degree/licensure», у каждой ветки **своя страница**. У нас та же развилка
дословно есть в данных: «При наличии медицинского образования — выдаём удостоверение
о повышении квалификации гособразца с возможностью регистрации баллов ЗЕТ», иначе —
сертификат международного образца. Мы держим это в аккордеоне на трёх страницах институтов.

#### Учебная траектория

На `/education` секции — **ступени траектории, а не хронология**: «Start your training today»
(вводные) → «Advanced Practice Modules» → «Explore all functional medicine core curriculum»
→ «Learn how you can become Functional Medicine Certified».

У нас траектория уже закодирована в данных и нигде не показана: **48 из 115** семинаров имеют
явное «Обязательное условие: У вас должен быть пройден семинар …» с точным названием
предшественника. Из этого строится настоящий граф. Предлагаю компонент `.pathway`:
цепочка `ПК-1 → ПК-2 → … → ПК-7` горизонтальной лентой (на мобильном — вертикальной),
пройденная часть не отмечается (у нас нет аккаунтов), текущий семинар подсвечен
`--border-accent`, у каждого шага — название, код и ссылка. Плюс на самой странице семинара
блок **«Перед этим семинаром»** со ссылкой на предшественника и **«После этого семинара»**
со ссылками на тех, у кого он указан предусловием (обратный индекс строится из тех же данных).
Это чистый статический граф, 0 KB JS.

### 8.3 (в) Real World CE: «практика → результат → доказательство» на странице семинара

Приёмы, которые беру: ярлыки-надзаголовки капсом над блоками, явно помеченный блок
`OUTCOME`, сравнительная таблица «до/после», триада «пара слов + одна строка».
SaaS-визуал не беру по прямому указанию.

Порядок блоков страницы семинара. В скобках — источник данных и фактический объём.

| # | Блок | Слой | Источник, объём |
|---|---|---|---|
| 1 | Шапка: eyebrow «Семинар» + код (ПК-4) · H1 · обещание одной строкой · формат · даты · объём · цена · CTA | — | `seminars.name`, `schedule_entries` |
| 2 | **Триада чисел**: город · часы · режим дня | практика | `city`, `duration`, «Как проходит обучение» (78 семинаров, медиана 94 знака) |
| 3 | **«Перед этим семинаром»** — предусловие ссылкой | практика | «Обязательное условие» — **48 из 115** |
| 4 | `ЧЕМУ ВЫ НАУЧИТЕСЬ` — 5–7 пунктов, каждый с глагола | практика | из «Учебного плана»; у IFM это `Learning Objectives`, все пункты начинаются с Identify / Differentiate / Utilize / Recommend / Foster / Explain / Engage |
| 5 | `КАК ПРОХОДИТ` — режим, формат работы, что взять с собой | практика | «Как проходит обучение» (78) + «Рекомендации» (48, медиана 257: книга к прочтению, свободная одежда, полотенце) |
| 6 | `РЕЗУЛЬТАТ` — 3 карточки-строки «пара слов + одна строка» | **результат** | вывести из «Учебного плана»; ярлык `OUTCOME` — приём Real World CE |
| 7 | `ВЫДАВАЕМЫЕ ДОКУМЕНТЫ` — **две ветки**: с медобразованием (удостоверение о ПК гособразца + баллы ЗЕТ) / без (сертификат международного образца, англ.+рус.) | **результат** | «Выдаваемые документы» — **69 из 115**, медиана 271 знак |
| 8 | `ПОДТВЕРЖДЕНИЕ` — международный реестр IAHE, подпись преподавателя, аккредитация, лицензия | **доказательство** | там же; у IFM аналог — «AFMCP is part of ACCME accredited functional medicine training» |
| 9 | `КТО ВЕДЁТ` — портретная полоса `.faculty-strip` + биографии | **доказательство** | `teachers` 27/27 с фото, `bio_html` |
| 10 | `ОТЗЫВЫ` — с полной атрибуцией (имя, специальность, город, год) | **доказательство** | **данных нет** → §8.4 |
| 11 | `КОМУ ПОДОЙДЁТ` — список специальностей | — | «Для кого подойдет» — 83 из 115, медиана 201 знак |
| 12 | **Учебный план** — сгруппированный, ВНИЗУ страницы | — | 80 из 115, медиана **801**, максимум **5 281** знак |
| 13 | «После этого семинара» — куда дальше по траектории | — | обратный индекс предусловий |
| 14 | Расписание и цены этого семинара | — | `schedule_entries` |
| 15 | FAQ (оплата, юрлицо, язык, съёмка, запись) | — | 3 институтских FAQ по 6 вопросов |

Порядок 2 → 3 → 4 → 5 (практика) → 6 → 7 (результат) → 8 → 9 → 10 (доказательство) и есть
запрошенная иерархия. Учебный план (пункт 12) сознательно уехал вниз — см. §8.4.

### 8.4 (г) «Сокращение объёма»: у нас обратная задача

**Честно: приём Wellesley к нам неприменим, и я не рекомендую его даже как ориентир.**
У Wellesley было 8 000+ страниц несогласованного разрастания по департаментам, они свели
их к 1 000 (−88%). У нас 260 страниц, и проблема ровно противоположная: страницы
**недозаполнены**. `/oplata` — 1 340 знаков prose (§7.0), 115 семинаров без единого
изображения, все 115 со статусом «не запланирован». Сокращать нечего; ограничение владельца
«ничего не терять» тут не конфликтует с референсом, а совпадает с фактами.

Что переносится из кейса — не сокращение, а **приоритизация и модульность**: «program cards»
и «faculty profiles» как переиспользуемые компоненты, единая витрина идентичности.

Сокращение **видимого** объёма, без удаления, четырьмя приёмами:

1. **Порядок как приоритет.** Учебный план (до 5 281 знака) уезжает в пункт 12 из 15.
   Ровно как у IFM: их `Course Schedule` из 6 глав и ~100 тем стоит после отзывов и
   преподавателей, а не в начале.
2. **Sticky-навигация по разделам страницы** (приём IFM, 10 ярлыков). Длинная страница
   перестаёт быть длинной, потому что до любого блока один клик. Реализуется на якорях
   и `scroll-margin-top` (§4.3) — 0 KB JS.
3. **Группировка внутри длинного блока.** Учебный план разбить на дни или темы, как IFM
   бьёт свой на `Chapter 1…6`. Ничего не скрывается, но простыня становится оглавлением.
4. **Прогрессивное раскрытие только там, где блок реально длинный** и вторичен:
   политики, FAQ, полные реквизиты. На `/oplata` при 1 340 знаках аккордеон, наоборот,
   вредит (§7.0) — там его убираем.

#### Вопросы к заказчику (не решать самим)

Ни один пункт не про удаление функционала — это про недостающее и про дубли.

1. **Фотографии.** Нужны кадры **≥2400px по длинной стороне**: залы во время практики,
   работа в парах, преподаватель у стола. Сейчас максимум 1280px, и это видеопревью.
   Без них «люди как главный образ» невозможны ни в одном варианте. (Задача #14.)
2. **Портреты преподавателей**: 27 из 27 есть, но нужны их размеры/качество под
   портретный кроп 3:4 при 800px по короткой стороне; сейчас таких файлов 17.
3. **Отзывы участников** — в данных нет ни одного. Нужны 6–10 с согласием на публикацию
   и атрибуцией: имя, специальность, город, год обучения.
4. **Статус 115 семинаров.** Все `not_planned`. Какие из них действительно снятые, а какие
   «набор идёт, дата уточняется»? От этого зависит, показывать бейдж «Дата уточняется»
   или «Архив». Формулировку «К сожалению, данный курс…» предлагаю заменить — подтвердить.
5. **`oldPrice` всегда 0** во всех 50 событиях. Скидки/акции сейчас есть? Если нет —
   механику зачёркнутой цены не строим (подтвердить, а не выбрасывать молча).
6. **Оплата юрлицом.** Есть ли счёт-договор, требуется ли отдельная форма? Сейчас это
   одна строка FAQ; у IFM «Group Rates» — строка прайса.
7. **Уровни и коды.** Подтвердить схему `ПК-1…ПК-7`, `ФПК-1…ФПК-4`, `SER-N`, `КСТ-N`:
   это официальная нумерация ступеней? Нужна, чтобы строить траекторию и фасет «Уровень».
8. **Баллы ЗЕТ** упомянуты только для курса «Прикладная кинезиология». Для остальных
   начисляются? Это сильный аргумент для врачей и просится в шапку семинара.
9. **Дубль контента**: блок «Для кого подойдёт» у 22 из 83 семинаров — один и тот же
   текст. Оставляем как есть или заказчик хочет различать? (Не удаление, а уточнение.)

### 8.5 (д) Аудитории — проверено по данным

Проверил все наблюдения лида. Три подтверждаются, одно надо переформулировать, одно снимаю.

| Ось | Вердикт | Доказательство в данных |
|---|---|---|
| **Ступень подготовки: новичок / с пройденными ступенями** | **Подтверждена, самая сильная** | «Обязательное условие: У вас должен быть пройден семинар …» — **48 из 115**, с точным названием предшественника. «Уровень N» в названии — **53 из 115**. Коды `ПК`(16), `ФПК`(14), `SER`(8), `КСТ`(8). У IFM ровно этот фасет: `Level / Experience: Foundational / Advanced` |
| **Наличие медицинского образования** | **Подтверждена, недооценена** | «При наличии медицинского образования — выдаём удостоверение о повышении квалификации гособразца», иначе сертификат. Есть во всех **3** институтских FAQ + в «Выдаваемых документах» 69 семинаров. «Для обучения в ИКПК в большинстве случаев не требуется специального медицинского образования». Это ось **результата** (какой документ на выходе), а не только входа. У IFM из неё сделаны два credential с отдельными страницами |
| **Юридические лица, оплачивающие обучение сотрудников** | **Подтверждена, но это не путь по сайту** | «Может ли обучение оплачивать юридическое лицо?» — во всех **3** институтских FAQ: «Да. Мы принимаем оплату от юридических лиц на наш расчетный счет ООО «ИКПК»». Одна строка на весь сайт. Рекомендация: не делать «раздел для юрлиц» (нечем наполнить), а сделать **блок на `/oplata` + строку в прайсе семинара** по образцу «Group Rates» у IFM |
| **Врачи разных специальностей** | **Снимаю как фасет** | 83 блока «Для кого подойдёт», но лишь **29 уникальных текстов**, и 22 из 83 — один и тот же generic-список. Пересечение огромное: «массаж» в 72/83, «врач» 67/83, «остеопат» 66/83, «терапевт» 64/83, «мануальн» 62/83. Фильтр по специальности отсеивал бы почти ничего. Оставить как контент внутри страницы семинара, фасетом не делать |
| **Институт / школа** | Подтверждена, уже в данных | Апледжера 23, ИКПК 21, Барраля 6 события; 3 института со своими FAQ и своими документами |
| Студенты медвузов | Слабая, отдельного пути не заслуживает | «студент» упомянут в 22 из 83 блоков, всегда как приписка к списку врачей |
| Пациенты / широкая публика | **Отсутствует** | Ни одного признака. У ИКПК нет аудитории «пациент» — в отличие от Branksome с шестью путями, у нас максимум три |

**Три различимых пути, а не шесть.** И — важно для §8.1 — это уровень ИА, одинаковый
для всех вариантов; по вариантам разводится только оформление входов:

1. **«Я начинаю»** → базовые семинары без предусловий (67 из 115), что нужно знать заранее
   («базовые знания анатомии»), какой документ получу.
2. **«Я продолжаю»** → траектория и следующая ступень (48 семинаров с предусловием),
   компонент `.pathway`, блоки «Перед этим» / «После этого».
3. **«Меня оплачивает организация»** → счёт, реквизиты, договор, группа — блок на `/oplata`
   и строка в прайсе, не отдельный раздел.

Поперёк всех трёх — развилка **с медобразованием / без**, потому что она определяет
результат (удостоверение о ПК + ЗЕТ против сертификата). Её место — в блоке
«Выдаваемые документы» на каждой странице семинара (пункт 7 в §8.3), двумя явными ветками,
а не одним абзацем в аккордеоне.
