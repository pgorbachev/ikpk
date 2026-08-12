## Context

На базовом состоянии `origin/main@2d48e84db36c013fabcbbe9ba389e1f4debca639`
rich HTML проходит через `web/src/lib/html-cleaner.ts`, после чего вставляется в Astro
через `set:html`. Cleaner исправляет legacy-разметку и добавляет продуктовые обёртки,
но не является границей доверия. В коде есть 13 не-JSON-LD sink-ов и два отдельных
JSON-LD sink-а, защищённых `serializeJsonLd()`.

Текущий Git-снимок данных проверяется вместе с кодом: в нём не найдено активных payload,
а единственный iframe — существующий RUTUBE player. Этот факт позволяет сохранить
текущий контент без миграции данных, но не является достаточной защитой для повторного
импорта или будущей CMS. Мотивация и контракт описаны в `proposal.md` и
`specs/rich-content-safety/spec.md`.

## Goals / Non-Goals

**Goals:**

- сделать типизированную, fail-closed границу между нормализованным контентом и
  `set:html`;
- выразить политику безопасности одной конфигурацией, пригодной и для unit-тестов, и
  для проверки итоговой сборки;
- сохранить семантику текущего каталога и отдельно, предсказуемо ужесточить RUTUBE
  iframe;
- автоматически обнаруживать новый sink, обход политики и регрессию в собранном HTML.

**Non-Goals:**

- CSP, TLS, доступ к demo/preview и прочие заголовки раздачи — это отдельный change,
  который должен быть согласован с активным `serving-cache-headers`;
- роли и permissions Strapi, доверие к importer-у и его SSRF-защита;
- проверка URL в типизированных полях карточек, кнопок и metadata, которые не приходят
  из rich HTML;
- изменение контракта JSON-LD или замена `serializeJsonLd()`;
- исправление всех эвристик legacy-нормализатора, если они не влияют на безопасность
  границы.

## Decisions

### 1. Санитизация выполняется последней серверной стадией

До нормализации `cleanBodyHtml()` выполняет ресурсный preflight, а после всех
преобразований результат проходит через поддерживаемый серверный allowlist-санитайзер
(предпочтительно `sanitize-html`) и только затем получает
экспортируемый opaque/branded type `SafeRichHtml`; brand-symbol и единственная функция,
которая создаёт значение этого типа, остаются приватными внутри policy-модуля. Source
gate отдельно запрещает `as SafeRichHtml` за пределами этого модуля. Пакет и его
зафиксированная версия выбираются при реализации после проверки совместимости с текущим
Node и lockfile audit.

Санитайзер стоит последним, потому что legacy-нормализатор сам создаёт теги и атрибуты:
санитизация только входа не защищает от дефекта последующего преобразования. Кроме того,
`RichContent.astro` **повторно санитизирует** значение непосредственно в том же модуле и
выражении, которое передаёт его в `set:html`. Идемпотентность делает этот defence-in-depth
проход детерминированным, а поддельный brand через `as`/`any` не превращается в доверие.
Ошибка инициализации или обработки пробрасывается в сборку; возврат исходной строки
запрещён.

Ресурсный preflight ограничивает один вход 2 097 152 байтами, 50 000 parsed nodes и
глубиной 256; результат также ограничен 2 097 152 байтами. Порог выбран с запасом над
максимумом текущего каталога — 514 009 байт на базовом SHA. Ошибка содержит тип и ID
материала, но не выводит его HTML. Byte-limit срабатывает до regex-нормализатора;
структурные лимиты — после линейного tolerant parse и до legacy-преобразований.

Альтернативы:

- собственные regex-фильтры отвергнуты: HTML, сущности, URL и browser parsing создают
  слишком много способов обхода;
- DOMPurify с JSDOM отвергнут как более тяжёлая DOM-среда для build-time задачи, пока
  политика не требует browser DOM;
- санитизация только в CMS/importer отвергнута: она оставляет несколько источников с
  разными гарантиями и не защищает текущий снимок.

### 2. Один компонент владеет не-JSON-LD sink-ом

Добавляется `RichContent.astro`: он принимает `SafeRichHtml`, обязательно повторяет
санитизацию, ставит стабильный маркер `data-safe-rich-content` и только после этого
вызывает `set:html`. Все 13 текущих потребителей
переносятся на него. Проверка AST исходников разрешает `set:html` только в этом компоненте
и в `web/src/components/HeadMeta.astro` и `web/src/components/Breadcrumbs.astro`, где
выражение обязано проходить через `serializeJsonLd()`. Gate переиспользует существующий
Astro-AST collector и invariant из `web/tests/json-ld.test.ts`, а не создаёт более слабую
проверку только по whitelist путей.

Сочетание opaque type и source gate выбрано вместо соглашения об именах функций:
TypeScript ловит случайную передачу обычной строки, а gate ловит Astro-шаблоны и новый
sink до того, как он попадёт в output scan. Маркер компонента даёт parsed-output gate
точную область и не смешивает rich content с собственными inline-скриптами приложения.

Гейт инвентаризирует не только Astro `set:html`, но и `is:raw`, непустые присваивания
`innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`/`writeln`,
`Range.createContextualFragment`, HTML-режим `DOMParser`, `srcdoc` и browser API
`setHTMLUnsafe`. Существующие присваивания пустого строкового литерала `innerHTML = ''`
разрешаются как точное исключение; непустое или вычисляемое значение запрещено.

### 3. Allowlist закрыт и соответствует фактической семантике контента

Базовый список элементов:

- структура: `p`, `br`, `hr`, `h2`–`h6`, `div`, `span`, `section`, `article`, `aside`,
  `address`;
- списки и раскрытие: `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `details`, `summary`;
- форматирование: `strong`, `b`, `em`, `i`, `u`, `s`, `sup`, `sub`, `code`, `pre`,
  `blockquote`;
- медиа, ссылки и время: `a`, `img`, `figure`, `figcaption`, `time`;
- таблицы: `table`, `caption`, `colgroup`, `col`, `thead`, `tbody`, `tfoot`, `tr`, `th`,
  `td`;
- `iframe` обрабатывается отдельным правилом RUTUBE и не входит в общий allowlist.

Общие разрешённые атрибуты ограничены `id`, `class`, `title`, валидным `lang` и
`dir="ltr|rtl|auto"`. Accessibility-исключения закрыты: `aria-label` разрешён на
`a`, `img`, `figure`, `table` и `.table-scroll`; `aria-labelledby`/`aria-describedby` —
на `section`, `article`, `aside`, `details`, `figure`, `table`; `role="region"` — только
на `.table-scroll`. Для `a` разрешены `href`, `target`, `rel`; для
`img` — `src`, `srcset`, `sizes`, `alt`, `width`, `height`, `loading`, `decoding`; для
таблиц — `colspan`, `rowspan`, `scope`, `headers`; для `details` — `open`; для `time` —
синтаксически валидный `datetime`.

Исключения для атрибутов, детерминированно созданных cleaner-ом, перечислены закрыто:
`tabindex="0"` только на `.table-scroll`, `data-wrapped` только на `table`,
`data-legacy-cta` и `data-legacy-cta-unresolved` только на элементах, которые создаёт
`normalizeLegacyControls()`. Эти атрибуты входят в characterization и idempotence
fixtures. Другие `data-*`, `tabindex`, `style`, `contenteditable`, `srcdoc`, `formaction`,
XML/XLink и все `on*` запрещены.

Активные запрещённые элементы (`script`, `style`, `object`, `embed`, `svg`, `math`,
`template`, `base`, `meta`, `link`) удаляются вместе с поддеревом. Неизвестный неактивный
контейнер разворачивается с сохранением безопасных детей. Это не позволяет тексту внутри
`script` повторно интерпретироваться как HTML и одновременно сохраняет авторский текст
из безвредной legacy-обёртки.

Альтернатива с разрешением произвольных классов и атрибутов «для совместимости»
отвергнута: она превращает allowlist в denylist и усложняет доказательство политики.
Классы оставлены, поскольку существующий CSS-контракт зависит от них; новое исключение
для атрибута требует отдельного тестового fixture.

### 4. URL разбираются по типу атрибута

Перед проверкой значение декодируется как HTML, очищается от управляющих символов и
разбирается URL parser-ом с фиксированным HTTPS base. Принимаются root-relative и обычные
path-relative формы (`/`, `./`, `../`, `lesson/page`, `?`, `#`), если до разбора у них
нет схемы и они остаются на фиксированном base origin. Protocol-relative `//host`
отвергаются.

- `a[href]`: относительные адреса, `http:`, `https:`, `mailto:`, `tel:`;
- `img[src]` и каждый кандидат `img[srcset]`: только root-relative `/media/**`, который
  существует в media manifest; внешние и обычные path-relative изображения запрещены;
- credentials запрещены для сетевых URL; CR/LF запрещены во всех значениях;
- при одном невалидном кандидате удаляется весь `srcset`, а не только подозрительная
  часть.

Для ссылок сохраняется только `target="_blank"`; другие target удаляются. `rel`
канонизируется по токенам `nofollow`, `noopener`, `noreferrer`, `sponsored`, `ugc`,
`opener` всегда удаляется, а `_blank` всегда получает `noopener noreferrer`.

Проверка выполняется transform hook-ом поверх санитайзера, а не только его списком
schemes. Parsed-output gate намеренно не импортирует эту функцию или allowlist: он имеет
собственный минимальный denylist, независимо разбирает URL/iframe и тем самым ловит
ошибочное расширение общей policy.

### 5. RUTUBE нормализуется в фиксированный capability

Iframe сохраняется только для URL без credentials, query и fragment, с origin
`https://rutube.ru` на стандартном порту и path
`^/play/embed/[A-Za-z0-9_-]+/$`. Выходной iframe строится заново и не наследует
авторские разрешения:

- `sandbox="allow-scripts allow-same-origin allow-presentation"`;
- `allow="autoplay; encrypted-media; fullscreen; picture-in-picture"`;
- `referrerpolicy="no-referrer"`, `loading="lazy"`;
- фиксированный непустой `title="Видео RUTUBE"` и `allowfullscreen`;
- канонический `src`; дочернее содержимое iframe удаляется.

`allow-same-origin` вместе с `allow-scripts` ослабляет sandbox, но выбран для
совместимости стороннего player-а. Риск ограничен точным origin/path, разными origin
player-а и сайта и отсутствием авторского управления разрешениями. Любое последующее
изменение набора permissions требует изменения capability и повторной стендовой проверки.

Сохранение произвольных video-hosts или query-параметров отвергнуто: в текущем каталоге
их нет, а каждый новый origin является отдельным доверием и должен пройти review.

### 6. Проверяется композиция, а не только helper

Набор обязательных проверок состоит из четырёх уровней:

1. unit-матрица payload-ов, URL, атрибутов, RUTUBE и идемпотентности;
2. source AST/TypeScript gate для полного реестра raw-HTML sinks и brand casts;
3. component render test, который передаёт hostile и поддельно branded fixtures через
   реальный cleaner и
   `RichContent.astro`;
4. parsed-output scan production- и demo-сборок по `data-safe-rich-content`, с адресом
   файла/страницы в ошибке.

Characterization текущего каталога сравнивает структурный fingerprint до и после:
нормализованный текст, заголовки, списки, таблицы, безопасные link/image targets,
`details` и RUTUBE. Сравнение не привязывается к косметическому порядку атрибутов.
До снятия финального fingerprint текущий внешний
`https://ikpk.su/api/upload/file/0acd713c-1477-4c6c-93ad-1596d2a17304` переносится через
существующий media pipeline в `/media/**`; старый production не становится runtime-
зависимостью.

Тестовая сессия отдельно демонстрирует RED на ещё не реализованной границе и негативно
проверяет каждый новый gate контролируемой мутацией. Это защищает от «зелёного» теста,
который не достигает sink-а.

## Risks / Trade-offs

- [Легитимный legacy-атрибут будет удалён] → characterization инвентаризирует отличие;
  исключение добавляется только вместе с минимальным fixture и обоснованием.
- [RUTUBE player перестанет работать из-за sandbox/referrer policy] → отдельный render-
  fixture и стендовая проверка player-а до merge; расширение capability требует review.
- [Новая зависимость сама содержит уязвимость] → фиксированная версия/integrity в
  lockfile, review каждого advisory во всём parser subtree независимо от severity,
  проверка provenance/maintenance и отсутствие runtime-доставки в browser bundle.
- [Opaque type будет обойдён cast-ом или `any`] → терминальная повторная санитизация в
  компоненте, source gate и независимый parsed-output scan дают три уровня защиты.
- [Двойной проход меняет HTML] → побайтовая проверка идемпотентности является частью
  обязательного контракта.
- [Output scan ошибочно проверит собственный JS приложения] → анализируются только
  поддеревья `data-safe-rich-content`, а не весь HTML как строка.

## Migration Plan

1. На точном базовом SHA сохранить реестр sink-ов и структурный fingerprint текущего
   каталога.
2. Перед test-only сессией повторно сверить активные `architecture-frame-prototypes` и
   `online-payment-flow`: первый меняет три preview sink-а, второй — `oplata.astro` и
   `normalizeLegacyControls()`. Если один из них приземлился первым, rebase выполняется
   до фиксации baseline; второй change затем обновляется относительно нового
   `RichContent` contract. Пересекающиеся версии не сливаются без повторного sink-
   инвентаря, build-гейтов и строгой OpenSpec-валидации.
3. В отдельной чистой сессии и worktree написать тесты по spec, предъявить RED и
   негативную проверку гейтов; production-код не менять.
4. Другой исполнитель добавляет политику, тип и компонент, затем мигрирует все текущие
   не-JSON-LD sink-и.
5. Выполнить unit/component тесты, обе сборки, parsed-output scan, typecheck/lint и
   dependency audit; отдельно открыть текущее RUTUBE video на тестовом стенде.
6. Провести два независимых code review, устранить подтверждённые находки и повторить
   гейты.
7. Выпустить вместе с новым сайтом; локальная миграция одного внешнего изображения
   входит в этот релиз, отдельный backfill не требуется.

До подключения недоверенного источника rollback возможен на проверенный Git-снимок. После
подключения CMS или автоматического импорта появляется необратимая migration boundary:
rollback на любой artifact без capability `rich-content-safety` запрещён. Допустимы
последний известный sanitizer-enabled artifact, безопасная maintenance page или
roll-forward. Одновременно останавливаются ingestion/rebuild, проверяется опубликованный
output и очищаются server/CDN caches; одного отключения feed недостаточно.
