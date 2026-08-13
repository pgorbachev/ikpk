## Purpose

Определяет единую проверяемую границу безопасности для HTML-контента из legacy-снимка,
импорта и будущей CMS, сохраняя разрешённую структуру материалов без исполнения кода.

## ADDED Requirements

### Requirement: Единая граница безопасного rich HTML

Система SHALL пропускать каждый не-JSON-LD HTML-фрагмент, вставляемый без экранирования,
через один fail-closed конвейер нормализации и санитизации. Последняя санитизация SHALL
выполняться в центральном rich-content sink непосредственно перед рендером. Добавление
ещё одного не-JSON-LD raw sink SHALL считаться изменением capability; одной записи в
реестре недостаточно.

#### Scenario: Контент из любого поддерживаемого источника
- **WHEN** страница получает rich HTML из текущего JSON-снимка, восстановленной панели,
  повторного импорта или будущей CMS
- **THEN** в сгенерированную разметку попадает только результат единой границы санитизации

#### Scenario: Новый raw-HTML sink известного синтаксического класса
- **WHEN** исходный код добавляет любой production `set:html` вне центрального
  `RichContent.astro` и двух JSON-LD sinks `HeadMeta.astro`/`Breadcrumbs.astro`, `is:raw`, непустой
  `innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`/`writeln`,
  `createContextualFragment`, HTML-режим `DOMParser`, `srcdoc` или `setHTMLUnsafe`
- **THEN** обязательный source gate завершается ошибкой до публикации

#### Scenario: Поддельный безопасный результат
- **WHEN** обычная строка или поддельный объект передаётся в центральный sink через cast,
  `any` либо ошибочный helper
- **THEN** runtime-проверка не признаёт его результатом cleaner-а, системные маркеры
  удаляются, а hostile markup санитизируется непосредственно перед рендером

#### Scenario: Сбой санитизации
- **WHEN** санитайзер не может обработать фрагмент или загрузить утверждённую политику
- **THEN** сборка завершается ошибкой и SHALL NOT подставлять исходный HTML как fallback

### Requirement: Исполняемая разметка не переживает границу

Система SHALL удалять активные элементы вместе с их исполняемым содержимым, включая
`script`, `style`, `object`, `embed`, `svg`, `math`, `template`, `base`, `meta` и `link`.
Она SHALL удалять inline-обработчики событий, атрибут `style`, `srcdoc`, `formaction`,
XML/XLink-ссылки и любой атрибут либо URL, отсутствующий в закрытой матрице.

#### Scenario: Скрипт с маскирующимся текстом
- **WHEN** вход содержит `<script><img src=x onerror=alert(1)></script>` или эквивалент с
  другим регистром, сущностями и пробелами
- **THEN** выход не содержит ни элемент `script`, ни его содержимое как активный HTML

#### Scenario: Активная вложенная разметка
- **WHEN** вход содержит `svg`, `math`, `object`, `embed`, `template` или `srcdoc` с
  вложенным payload
- **THEN** активное поддерево отсутствует в выходе

#### Scenario: Событие или inline style на разрешённом элементе
- **WHEN** разрешённый элемент содержит `on*` или `style`
- **THEN** элемент может сохраниться, но оба класса атрибутов отсутствуют в выходе

#### Scenario: Неподдерживаемый инертный wrapper
- **WHEN** вход содержит элемент вне allowlist и вне discard-subtree списка активных
  элементов, например `<center>безопасный текст</center>`
- **THEN** wrapper удаляется, а его descendants рекурсивно санитизируются и безопасный
  текст сохраняется

### Requirement: Source- и rendered-corpus проверяются раздельно

Система SHALL поддерживать два явных characterization-корпуса. Source-corpus SHALL
включать все значения следующих baseline selectors: `articles[*].body_html`,
`course_groups[*].description_html`, `institutes[*].description_html`,
`seminars[*].description_html`, `static_pages[*].body_html`, `teachers[*].bio_html`,
`video_playlists[*].description_html`, `news[*].description`, `promotions[*].description`
и все строковые values `collapsible_panels.json`. Независимый discovery gate SHALL
обходить все входные JSON и CMS schema, считать HTML-bearing строкой любое поле с
суффиксом `_html` либо значением, tolerant parse которого содержит element node, и падать
на найденном значении вне selector list или на selector без source registry entry.
Каждый CMS attribute с `type: "richtext"` SHALL считаться HTML-bearing selector и иметь
registry entry даже при пустой базе; на базовом schema это article.body, page.body,
seminar.description/full_text, promotion.description, institute.description,
schedule-entry.description/additionalText, news-item.description,
course-group.description и teacher.bio. Новый `richtext` attribute автоматически входит
в gate; исключение требует изменения capability. Rendered-corpus
SHALL включать каждую rich-content область production- и demo-сборок. Миграции текущего
контента SHALL выполняться до фиксации финальных fingerprints.

#### Scenario: Текущий source-corpus
- **WHEN** все исходные фрагменты нормативного selector list проходят новый конвейер
- **THEN** fingerprint сохраняет текст, порядок безопасных блоков, заголовки, списки,
  таблицы, временные метки, ссылки, изображения, `details`, checkbox/label и RUTUBE

#### Scenario: Текущий rendered-corpus
- **WHEN** production- и demo-сборки проходят новый конвейер
- **THEN** fingerprint сохраняет те же пользовательские блоки и цели ссылок/media на
  всех фактически собранных страницах, а реестр областей не теряет ни одного sink output

#### Scenario: Текущее source-only видео
- **WHEN** RUTUBE iframe присутствует в source-corpus, но не попадает в текущий dist из-за
  route extraction
- **THEN** source characterization и отдельный component render fixture всё равно
  проверяют сохранение видео и фиксированные permissions

#### Scenario: Source-only video playlist
- **WHEN** `video_playlists[*].description_html` не имеет текущего route sink
- **THEN** discovery gate всё равно включает каждый непустой fragment в source registry,
  sanitizer characterization и migration verification

### Requirement: Текущая видимая семантика мигрируется до запрета активной разметки

До включения sanitizer policy система SHALL применить следующий закрытый migration
mapping ко всем baseline selectors. Inline SVG удаляется как поддерево; если он был
единственным именующим содержимым ссылки, ссылка получает видимый текст
`Скачать документ` для локального document URL или `Открыть ссылку` для иного URL и то
же accessible name. Остальной SVG считается декоративным legacy UI snapshot и не
заменяется. Inline `text-align:center|right` переносится в `rc-align-center|right`;
`font-size:14px|18px|20px|22px|inherit|var(--font-size-s)` — в
`rc-font-14|18|20|22|inherit|s`; значения `color` — в generated конечные классы
`rc-color-<stable-id>`, каждый из которых хранит точное утверждённое CSS value; для
rendered routes дополнительно фиксируется baseline computed value. Текущие декларации
payment content `display:flex`, `flex-direction:column`, `gap:24px` и `margin-left:15px`
переносятся соответственно в `rc-display-flex`, `rc-flex-column`, `rc-gap-24` и
`rc-ml-15`; это сохраняет измеренный layout `/oplata`.
Остальные inline declarations удаляются как legacy layout/UI implementation, не
являющаяся контентным контрактом. Manifest SHALL содержать source selector, stable
entity ID/JSON path, исходную декларацию или SVG context, точный replacement class/text,
accessible name и route (либо `source-only`); его строки выводятся детерминированно из
этого mapping и проходят review до написания RED-тестов.

#### Scenario: PDF-иконки и институтские иллюстрации
- **WHEN** текущие страницы содержат inline SVG внутри rich content
- **THEN** после миграции назначение ссылки и точный текстовый/accessibility эквивалент
  по mapping сохраняются без inline SVG

#### Scenario: Текущее видимое оформление
- **WHEN** текущий rendered-corpus использует mapped inline declaration, включая
  `text-align`, `font-size`, `color` и payment flex/spacing declarations
- **THEN** computed presentation сохраняется через конечные локальные классы и
  проверяется fingerprint плюс visual evidence на страницах с каждым семейством стилей

#### Scenario: Migration manifest неполон
- **WHEN** baseline selector содержит SVG либо mapped inline declaration без строки с
  stable entity ID/JSON path в migration manifest
- **THEN** pre-test gate завершается ошибкой; тестовая сессия не выбирает replacement
  самостоятельно

### Requirement: Allowlist является закрытым нормативным контрактом

Система SHALL разрешать только следующие rich-content элементы:
`p`, `br`, `hr`, `h2`–`h6`, `div`, `span`, `section`, `article`, `aside`, `address`,
`ul`, `ol`, `li`, `dl`, `dt`, `dd`, `details`, `summary`, `strong`, `b`, `em`, `i`, `u`,
`s`, `sup`, `sub`, `code`, `pre`, `blockquote`, `a`, `img`, `figure`, `figcaption`,
`time`, `label`, инертный checkbox `input`, `table`, `caption`, `colgroup`, `col`,
`thead`, `tbody`, `tfoot`, `tr`, `th`, `td` и условный RUTUBE `iframe`. Расширение
списка SHALL считаться изменением capability.

Разрешённые атрибуты SHALL составлять закрытую матрицу:

- на перечисленных элементах, кроме `input` и условного iframe, — `id`, `class`,
  `title`, синтаксически валидный `lang` и `dir` из `ltr|rtl|auto`;
- на `a` — `href`, только `target="_blank"` и `rel` только из `nofollow`, `noopener`,
  `noreferrer`, `sponsored`, `ugc`;
- на `img` — `src`, `srcset`, `sizes`, `alt`, положительные целые `width`/`height`,
  `loading` из `lazy|eager`, `decoding` из `async|sync|auto`;
- на `label` — `for`; на `input` — принудительные `type="checkbox"` и `disabled`, плюс
  boolean `checked`; любой другой `input` удаляется с сохранением безопасного текста;
- на `th`/`td` — положительные целые `colspan`/`rowspan`, `scope` из
  `row|col|rowgroup|colgroup`, `headers`; на `details` — boolean `open`; на `time` —
  синтаксически валидный `datetime`;
- `aria-label` — только на `a`, `img`, `figure`, `table` и `.table-scroll`;
  `aria-labelledby`/`aria-describedby` — только на `section`, `article`, `aside`,
  `details`, `figure`, `table`; `role="region"` и `tabindex="0"` — только на
  `.table-scroll`;
- системные markers входят в ту же закрытую матрицу: `data-wrapped` — только на `table`
  внутри непосредственного `.table-scroll[role="region"][tabindex="0"]`;
  `data-legacy-cta` — только на `a` с локальным fragment `href`;
  `data-legacy-cta-unresolved` — только на `span` без `href`;
  `data-safe-rich-content="<sink-id>"` — только на root wrapper центрального sink-а, где
  `<sink-id>` присутствует в ожидаемом rendered registry; reserved class token
  `.table-scroll` — только на `div[role="region"][tabindex="0"]`, непосредственно
  содержащем `table[data-wrapped]`; `.legacy-cta-unresolved` — только на
  `span[data-legacy-cta-unresolved]` без `href`. Эти формы SHALL присутствовать и в
  независимой полной копии output matrix.

Любой не перечисленный атрибут SHALL быть удалён, а ограниченное значение SHALL
валидироваться. Независимый output gate SHALL держать собственную полную копию матрицы,
не импортируя runtime policy.

#### Scenario: Checkbox вне удалённой формы
- **WHEN** безопасный `label` содержит `input type="checkbox"` вне legacy-формы
- **THEN** label и checked-state сохраняются, checkbox принудительно становится disabled,
  а `name`, `value`, `form*` и обработчики удаляются

#### Scenario: Попытка расширить матрицу конфигурацией
- **WHEN** runtime policy разрешает новый элемент, атрибут или значение без изменения spec
- **THEN** независимый parsed-output gate завершается ошибкой

### Requirement: Системные маркеры защищены от подделки

До legacy-нормализации система SHALL удалять из недоверенного входа reserved markers
`data-wrapped`, `data-legacy-cta`, `data-legacy-cta-unresolved`,
`data-safe-rich-content` и reserved class tokens `.table-scroll`,
`.legacy-cta-unresolved`. После нормализации sanitizer SHALL принимать
маркеры только в утверждённых структурных формах; terminal re-sanitization SHALL
различать runtime-authenticated pipeline output и обычный вход.

#### Scenario: Поддельный legacy CTA
- **WHEN** исходный CMS-фрагмент содержит `data-legacy-cta` или
  `data-legacy-cta-unresolved`
- **THEN** маркер удаляется до нормализации и не участвует в product/build gates как
  системно созданный CTA

#### Scenario: Утверждённые структурные формы
- **WHEN** нормализатор создаёт table wrapper либо legacy CTA
- **THEN** `data-wrapped` сохраняется только на `table` внутри непосредственного
  `.table-scroll[role="region"][tabindex="0"]`, `data-legacy-cta` — на `a` с локальным
  fragment href, а `data-legacy-cta-unresolved` — на `span` без `href`

### Requirement: URL проверяются по разобранной схеме

Система SHALL принимать в `a[href]` root-relative, path-relative, query/fragment URL и
схемы `http`, `https`, `mailto`, `tel`. В `img[src]` SHALL приниматься только существующий
base asset `/media/**`, представленный ключом media manifest. В `img[srcset]` SHALL также
приниматься derivative `/media/_w/<width>/<path>`, только если он обратимо соответствует
base manifest key, `<width>` присутствует в его `widths`, а производный файл существует.
Проверка SHALL выполняться после декодирования сущностей, удаления управляющих символов и
разбора URL. `javascript`, `vbscript`, `file`, `data` и protocol-relative `//host` SHALL
быть запрещены.

#### Scenario: Обфусцированный javascript URL
- **WHEN** URL кодирует или разделяет управляющими символами запрещённую схему, меняет
  регистр либо помещает безопасный hostname в query/credentials
- **THEN** опасный URL-атрибут отсутствует в выходе

#### Scenario: Responsive derivative cleaner-а
- **WHEN** cleaner создаёт `/media/_w/<width>/<path>` из base asset и manifest width
- **THEN** кандидат `srcset` сохраняется и проверяется по base manifest entry и наличию
  производного файла

#### Scenario: Смешанный или внешний srcset
- **WHEN** хотя бы один кандидат `srcset` внешний, protocol-relative, использует
  запрещённую схему либо не разбирается
- **THEN** весь `srcset` удаляется, а безопасный `src`, если он есть, сохраняется

#### Scenario: Внешний image src
- **WHEN** `img[src]` указывает на HTTP(S)-host, protocol-relative host или запрещённую
  схему
- **THEN** `img` удаляется безопасно, а исходный URL не попадает в output

#### Scenario: Неканонический локальный image src
- **WHEN** `img[src]` содержит root-relative либо path-relative адрес вне base manifest
  keys, включая `/images/**`, `../**` и derivative `/media/_w/**` вместо base asset
- **THEN** сборка завершается ошибкой с типом и ID материала и не публикует неоднозначную
  либо битую локальную ссылку

#### Scenario: Отсутствующий локальный asset
- **WHEN** base `/media/**` отсутствует в manifest либо утверждённый derivative не
  существует
- **THEN** сборка завершается ошибкой с типом и ID материала и не публикует битую ссылку

### Requirement: Новый таб не получает opener

Система SHALL сохранять только `target="_blank"`, удалять любое иное значение `target`
и канонизировать `rel` по закрытому allowlist. Токен `opener` SHALL всегда удаляться;
для `_blank` система SHALL добавлять `noopener noreferrer` независимо от hostname.

#### Scenario: Ссылка в новом табе
- **WHEN** безопасная ссылка содержит `target="_blank"` без `rel`, с `opener` или с
  неполным `rel`
- **THEN** выход содержит `_blank`, не содержит `opener` и содержит как минимум
  `noopener noreferrer`

### Requirement: RUTUBE является единственным разрешённым iframe

Система SHALL сохранять iframe только для URL без credentials, query и fragment, с
origin `https://rutube.ru`, стандартным HTTPS-портом и path
`^/play/embed/[A-Za-z0-9_-]+/$`. Выход SHALL заново получить точные значения
`sandbox="allow-scripts allow-same-origin allow-presentation"`,
`allow="autoplay; encrypted-media; fullscreen; picture-in-picture"`,
`referrerpolicy="no-referrer"`, `loading="lazy"`, `title="Видео RUTUBE"` и boolean
`allowfullscreen`. Любой иной iframe SHALL быть удалён вместе с дочерним содержимым.

#### Scenario: Похожий hostname или ослабление sandbox
- **WHEN** iframe использует похожий hostname, credentials, query/fragment, нестандартный
  порт, иной path либо авторские `sandbox`, `allow`, `srcdoc` или `on*`
- **THEN** неутверждённый iframe удаляется, а утверждённый получает только точные
  системные permissions

### Requirement: Недоверенный контент ограничен по ресурсам

Система SHALL отвергать фрагмент до legacy regex-нормализации, если UTF-8 размер
превышает 2 097 152 байта, tolerant parsed tree превышает 50 000 узлов или глубину 256.
Результат SHALL NOT превышать 2 097 152 байта. Ошибка SHALL содержать тип и ID материала,
но SHALL NOT включать исходный HTML.

#### Scenario: Большой или глубоко вложенный payload
- **WHEN** CMS/import передаёт oversized, слишком глубокий или чрезмерно разветвлённый
  HTML
- **THEN** сборка завершается контролируемой ошибкой до дорогостоящих regex-проходов и
  не публикует частичный либо исходный фрагмент

#### Scenario: Восстанавливаемая malformed-разметка в пределах лимитов
- **WHEN** tolerant parser получает malformed HTML, не превышающий byte/node/depth limits
- **THEN** система SHALL восстановить дерево по browser-conformant HTML tree-construction
  semantics, санитизировать его по закрытой матрице и сериализовать результат; parser,
  который не может обработать такую разметку, не подходит для реализации capability

### Requirement: Гейты не дают vacuous green и независимы от runtime policy

Terminal sanitizer SHALL быть детерминирован и идемпотентен. Source gate SHALL сверять
raw sinks с машинным реестром. Parsed-output gate SHALL независимо кодировать полную
закрытую матрицу, сверять фактический реестр `data-safe-rich-content` областей с ожидаемым
реестром production/demo routes и завершаться ошибкой при нуле либо пропаже областей.
Отдельный canary gate SHALL искать hostile canary tokens во всём `dist` и `dist-demo`, а
не только внутри отмеченных поддеревьев. В каждой из двух сборок того же прогона он SHALL
найти ровно один неопасный fixture-control token на ожидаемом test-only path; отсутствие
path/token, дубликат или отсутствие соответствующего sink marker SHALL завершать гейт
ошибкой. Output oracle SHALL разбирать целый собранный документ browser-conformant
parser-ом, независимым от runtime sanitizer parser-а.
Независимый whole-document hazard gate SHALL вне rich-content областей отвергать `on*`,
`srcdoc`, XML/XLink URL и запрещённые URL-схемы, а также любой элемент, browser semantics
которого создаёт nested browsing context либо загружает/исполняет script, style, document
или active foreign-content resource. Сюда входят, но не ограничиваются, `script`, `style`,
`iframe`, `frame`, `frameset`, `object`, `embed`, `base`, refresh-meta, stylesheet-link и
исполняемые SVG/MathML descendants. Такой output допускается только по утверждённому
test-owned реестру вывода шаблонов.

Для `script`/`style` реестр SHALL хранить глобальный набор уникальных body hashes либо
внешних asset identities и security-relevant атрибутов без route/count pinning. Для
редких high-risk элементов — nested browsing contexts, `object`/`embed`/`base`,
refresh-meta и stylesheet-link — он SHALL дополнительно фиксировать route, count и
placement. CI SHALL только сравнивать output с committed registry. Обновление выполняется
явно запускаемым tool в чистом worktree из назначенного reviewed source SHA: tool строит
candidate manifest, а изменение source и manifest проходит review до commit; registry
SHALL NOT обновляться либо приниматься из проверяемого CI `dist` в том же прогоне.

#### Scenario: Повторная terminal-санитизация
- **WHEN** уже санитизированная HTML-строка проходит terminal sanitizer второй раз в том
  же trust mode
- **THEN** результат побайтово совпадает с результатом первого прохода

#### Scenario: Runtime allowlist ошибочно расширен
- **WHEN** test-only hostile build fixture содержит `contenteditable`, произвольный
  `data-*` или иной элемент matrix-complement, а контролируемая runtime-мутация разрешает
  это значение
- **THEN** независимый output gate падает на выжившем нарушении

#### Scenario: Маркер областей удалён
- **WHEN** центральный компонент перестаёт выводить `data-safe-rich-content`
- **THEN** inventory gate падает на недостающих областях и SHALL NOT считать нулевой
  результат успешным

#### Scenario: Canary оказывается вне отмеченной области
- **WHEN** контролируемый raw sink выводит hostile canary вне `data-safe-rich-content`
- **THEN** whole-dist canary gate находит token и завершает проверку ошибкой с адресом
  страницы

#### Scenario: Test-only fixture не попал в сборку
- **WHEN** ожидаемый test-only path, его уникальный fixture-control token или его sink
  marker отсутствует в проверяемом output
- **THEN** canary gate завершается ошибкой, даже если hostile tokens также отсутствуют

#### Scenario: Parser differential
- **WHEN** misnested, foreign-content или entity-encoded mXSS fixture получает разное
  дерево в runtime parser и browser-conformant output oracle
- **THEN** oracle проверяет фактическое browser DOM-дерево и падает на активном либо
  отсутствующем в закрытой матрице результате

#### Scenario: Неизвестный sink выводит другой активный payload
- **WHEN** не распознанный source collector-ом sink выводит вне отмеченной области
  активный элемент, event handler, `srcdoc`, XML/XLink URL или запрещённую URL-схему без
  hostile canary token
- **THEN** whole-document hazard gate завершается ошибкой с адресом страницы и причиной,
  даже если source registry и marker inventory остались зелёными

#### Scenario: Разрешённый исполняемый вывод шаблона изменился
- **WHEN** template или bundler добавляет либо меняет исполняемый элемент относительно
  source-owned реестра
- **THEN** whole-document hazard gate падает до осознанного review и обновления реестра,
  а не принимает текущий `dist` как новый baseline автоматически
