## Context

На базовом состоянии `origin/main@2d48e84db36c013fabcbbe9ba389e1f4debca639`
legacy rich HTML нормализуется в `web/src/lib/html-cleaner.ts` и попадает в Astro через
raw sink. Машинный инвентарь на этом SHA находит 13 не-JSON-LD sink-ов и два JSON-LD
sink-а под `serializeJsonLd()`; числа являются свидетельством baseline, а не вечной
константой — реализация хранит и проверяет реестр.

Текущий контент имеет три особенности, которые первоначальный design не учёл:

- `injectImgDimensions()` создаёт responsive candidates
  `/media/_w/<width>/<path>`, которых нет отдельными ключами manifest, но width указан у
  base asset и файл создаётся `make-derivatives.ts`;
- две фактически собранные rich-content страницы содержат 65 content-origin inline SVG
  (PDF-иконки и институтские иллюстрации), а source-only selectors, включая
  `video_playlists[*].description_html`, содержат дополнительные legacy UI SVG/styles;
  поэтому mapping применяется к полному source-corpus, а не только к этим 65 узлам;
- единственный RUTUBE iframe и внешний `ikpk.su/api/upload/file/...` находятся в source
  fields, которые текущий course-group extractor не выводит. Сам локальный файл
  `0acd713c-...webp` и manifest entry уже существуют; не выполнена именно замена URL в
  `course_groups.json`.

Поэтому проверка только `dist`, только текста или только manifest keys дала бы ложную
совместимость. Нормативный контракт находится в `specs/rich-content-safety/spec.md`.

## Goals / Non-Goals

**Goals:**

- дать каждому source fragment из нормативного selector list одну fail-closed границу и terminal defence in
  depth непосредственно у raw sink;
- выразить runtime policy и независимый test oracle из одной нормативной spec, но не из
  одного программного объекта;
- сохранить текущую текстовую, медиа-, accessibility- и визуальную семантику через
  явные миграции до запрета inline SVG/style;
- не допустить vacuous green при пропаже marker-а, обходе отмеченной области или
  ошибочном расширении runtime allowlist.

**Non-Goals:**

- CSP, TLS, доступ к demo/preview и security headers — отдельный change после
  `serving-cache-headers`;
- роли/permissions Strapi, доверие к importer-у и SSRF ingestion path;
- URL в типизированных карточках, кнопках и metadata вне rich HTML;
- JSON-LD contract и `serializeJsonLd()`;
- enforcement аварийного rollback после подключения CMS. Это контракт deploy system,
  а не renderer-а; его надо описать в отдельном deployment-security change с объективным
  enforcement point. Здесь остаётся только безопасный renderer artifact.

## Decisions

### 1. Pipeline имеет два trust mode и runtime-authenticated результат

`cleanBodyHtml(raw, context)` выполняет:

1. byte limit и tolerant parse для node/depth limits;
2. удаление reserved markers/classes из недоверенного входа;
3. legacy-нормализацию и безопасные content migrations;
4. allowlist-санитизацию;
5. возврат объекта `SafeRichHtml`, содержащего HTML и непубличный runtime token.

Одного TypeScript brand недостаточно: `as` и `any` обходят compile-time гарантию, а
строка не несёт runtime provenance. Поэтому factory и token остаются приватными, а тип
объекта экспортируется для prop-а. Source gate запрещает внешнее конструирование/cast.

`RichContent.astro` принимает объект, проверяет token и всегда вызывает terminal
sanitizer в том же выражении, которое отдаёт строку `set:html`:

- authenticated output mode сохраняет только структурно валидные системные markers;
- untrusted mode для строки/подделки сначала удаляет reserved markers, затем применяет
  ту же security matrix;
- оба mode применяют resource limits и не возвращают raw fallback.

Terminal sanitizer обязан быть побайтово идемпотентным внутри одного mode. Полный legacy
pipeline не объявляется идемпотентным: он добавляет продуктовые обёртки и не должен
использоваться как доказательство terminal policy.

Package selection начинается с browser-conformant HTML tree construction: runtime parser
обязан проходить foster-parenting, active-formatting, foreign-content и entity fixtures
из spec. Поэтому `sanitize-html`/htmlparser2 не является предпочтительным и исключается,
если не получает browser-conformant tree извне. Предпочтительный кандидат — maintained
DOMPurify+JSDOM stack; допустима parse5-based tree transform с эквивалентной закрытой
policy. В обоих случаях независимый output oracle использует фактический DOM Chromium
через Playwright: JSDOM транзитивно использует parse5, поэтому пара JSDOM/parse5 не даёт
независимости. Отдельный dependency-graph gate запрещает общий прямой или транзитивный
parser engine между runtime и oracle.
Конкретные версии фиксируются после проверки Node compatibility, maintenance,
provenance, limits и всех advisory parser subtree. Синтаксическая malformed-разметка в
пределах лимитов сама по себе не является разрешённой причиной build failure.

### 2. Resource limits стоят до legacy regex-проходов

Вход ограничен 2 MiB, 50 000 узлами и глубиной 256; выход — 2 MiB. Максимальный текущий
source fragment на baseline равен 514 009 байтам, поэтому byte limit имеет почти
четырёхкратный запас. Сначала проверяются bytes, затем один линейный tolerant parse,
после чего запускаются существующие regex/циклы. Ошибка содержит source type/id, но не
HTML и не потенциальный secret из контента.

Альтернатива «санитизировать последней стадией без preflight» отвергнута: hostile input
может исчерпать CPU/память раньше границы.

### 3. Characterization разделён на source и rendered corpora

До test-only сессии утверждается закрытый selector list из spec. Независимый discovery
обходит все entity JSON и CMS schema: suffix `_html`, parsed element node либо CMS
attribute `type: "richtext"` означает HTML-bearing field; значение/attribute вне selector
list и selector без registry entry — ошибка даже при пустой CMS-базе.
Это явно включает source-only `video_playlists[*].description_html`, а не выводит
полноту из списка текущих routes. Для каждого source фиксируются type, stable ID, JSON
path и fingerprint. Отдельный rendered registry фиксирует каждый
`data-safe-rich-content="<sink-id>"` по production/demo path.

Source fingerprint включает текст и порядок блоков, headings, lists, tables,
`time[datetime]`, link/image targets, responsive candidates, details, inert checkboxes,
system markers, RUTUBE и SVG/style migration mapping. Rendered fingerprint дополнительно
сохраняет marker inventory и visual evidence. Сравнение не зависит от порядка обычных
HTML-атрибутов.

Этим закрываются две разные ошибки: source-only RUTUBE нельзя доказать через `dist`, а
layout/style loss нельзя доказать только по тексту source.

### 4. Inline SVG и style мигрируются до terminal policy

Inline SVG остаётся запрещённым active subtree: SVG имеет собственные URL/animation/
event поверхности, и «безопасный SVG subset» резко расширил бы policy. Нормативный
mapping из spec детерминирован: SVG-only link получает точный текст/accessibility label,
остальной legacy UI SVG удаляется как decorative. Для styles сохраняются точные
`text-align`, `font-size` и `color` families, а также текущие payment declarations
`display:flex`, `flex-direction:column`, `gap:24px`, `margin-left:15px` из mapping.
Остальные layout/UI declarations не являются принятым контентным контрактом и удаляются.

В начале отдельной чистой test-only сессии, до sanitizer RED-тестов, генератор создаёт
reviewable manifest со строкой на каждый SVG и mapped
declaration: selector, stable entity ID/JSON path, исходный context/value, точный
replacement class/text, accessible name и route либо `source-only`. Gate сравнивает
manifest с независимым discovery и падает при пропуске. Та же сессия получает product
mapping только из утверждённой spec, сохраняет negative-verification evidence, затем
использует reviewed manifest как test fixture. Computed-style assertions и снимки
проверяют каждое сохраняемое style family на фактически собранных routes.

### 5. Closed matrix сохраняет только инертные legacy controls

Tag/attribute matrix нормативно перечислена в spec. В дополнение к прежнему списку
сохраняются `label` и только `input[type=checkbox]`: checkbox получает `disabled`, может
сохранить `checked`, но теряет `name`, `value`, `form*` и handlers. Это согласует новый
security contract с принятым fixture `html-cleaner.test.ts`, не оставляя submit-capable
control.

Template-owned hooks не пропускаются через policy. В частности,
`data-testid="course-group-extra-content"` переносится/остаётся на внешнем wrapper
course-group template, который окружает центральный component; root
`data-safe-rich-content` и санитизированное поддерево не получают общего разрешения
`data-testid` либо произвольных `data-*`.

Существующий test внешнего Yandex image меняет смысл: direct `cleanBodyHtml()` больше не
обязан сохранять remote URL, потому что security boundary теперь живёт внутри helper-а.
Fixture локализуется до вызова либо ожидает безопасное удаление. Тестовая сессия должна
изменить это ожидание явно со ссылкой на spec, а не молча расширять allowlist.

### 6. Reserved markers очищаются до нормализации

Финальная строка не хранит происхождение, поэтому требование «атрибут создан конкретной
функцией» действительно непроверяемо одним terminal sanitizer. Вместо этого:

- untrusted pre-pass удаляет `data-wrapped`, оба `data-legacy-cta*`,
  `data-safe-rich-content` и reserved class tokens;
- нормализатор может создать их заново;
- authenticated output mode проверяет точную структурную форму;
- untrusted terminal mode снова удаляет markers из подделки.

Так idempotent re-sanitization authenticated output не уничтожает законные markers, а
CMS не может их отчеканить. Для table wrapper проверяется непосредственная структура;
для resolved CTA — `a` с fragment href; для unresolved — `span` без href.
`data-safe-rich-content` разрешается только на root wrapper центрального компонента со
значением из expected rendered registry. Эти формы являются частью полной normative
matrix и её независимой test-owned копии, а не неявными исключениями.

Активный `online-payment-flow` не меняет `normalizeLegacyControls()` — его proposal
говорит это явно. Пересечение ограничено `oplata.astro` и сохранением существующего CTA
contract при миграции sink-а.

### 7. Local media различает base assets и derivatives

Для `img[src]` base path обязан быть manifest key под `/media/**` с raster-расширением
`webp|png|jpg|jpeg` и положительными `width`/`height`; PDF и пустые document entries из
того же manifest не являются изображениями. Candidate `/media/_w/<width>/<path>
<width>w` разрешён только в `srcset`, если:

1. из path однозначно восстанавливается base `/media/<path>`;
2. width — положительное целое и есть в `manifest[base].widths`;
3. descriptor точно совпадает с width в URL, candidates не повторяют URL/width;
4. derivative file создан и существует в build input/output.

Outcome выбирается после классификации всех candidates. Любой broken-local candidate —
missing/noncanonical base или derivative, document/invalid dimensions, width вне manifest
либо несовпавший descriptor — имеет приоритет и валит build даже рядом с внешним
candidate. Только если broken-local нет, external, protocol-relative, forbidden-scheme,
malformed, `x`/missing/mixed descriptor или duplicate удаляет весь `srcset`. Любой локальный
`img[src]` вне canonical manifest base keys — включая `/images/**`, path-relative URL и
derivative в `src` — относится к fail-build, а не strip. Таким образом каждый input
попадает ровно в одну outcome-категорию.

Локальный asset `0acd713c-...webp` уже скачан и внесён в manifest; миграция состоит в
замене оставшегося remote URL в `course_groups.json` на существующий `/media/uploads/...`.

### 8. RUTUBE строится заново как один ограниченный capability

URL разбирается через `URL` и сверяется по точному origin/path, без credentials,
query/fragment и нестандартного порта. Attrs не сливаются с author input, а строятся
заново по точным значениям spec. `allow-same-origin` вместе с `allow-scripts` —
осознанный trade-off для совместимости player-а; изменение permissions требует spec
update и повторной стендовой проверки.

### 9. Source gate обеспечивает singleton sink, а output gate — независимый oracle

Невозможно статически обещать обнаружение любого будущего API или произвольного
динамического свойства. Поэтому source gate имеет честную ограниченную область:

- Astro AST collector разрешает production `set:html` только в `RichContent.astro` и
  точных JSON-LD sinks `HeadMeta.astro`/`Breadcrumbs.astro`, делегированных существующему
  invariant; он также запрещает `is:raw` и literal/expression/spread-варианты `srcdoc`;
- TypeScript AST collector проверяет перечисленные DOM raw sinks и SafeRichHtml casts;
- изменение registry, HTML-rendering dependency или parser config требует security
  fixture/review, а не опирается на фразу «или любой другой sink».

Built-output verification имеет четыре независимых слоя и разбирает целую страницу
фактическим DOM Chromium через Playwright. Он не использует JSDOM/parse5 как oracle ни при
JSDOM runtime, ни при parse5 transform; dependency-graph assertion доказывает отсутствие
общего прямого или транзитивного parser engine:

Недоверенный document никогда не загружается как страница. Playwright заранее открывает
контролируемый `about:blank`, ставит перехват с abort для каждого navigation/subresource
request и передаёт точные bytes в нативный Chromium
`DOMParser.parseFromString(..., "text/html")`. Возвращённый inert `Document` не
присоединяется к live DOM: его scripts/handlers/refresh не исполняются, main-frame URL не
меняется. Каждая request attempt синхронно abort-ится; ошибка — request, который interceptor
разрешил продолжить/завершить, либо изменение URL. `page.goto()`,
`page.setContent()`, `document.write()` и live `innerHTML` для проверяемых bytes запрещены.

1. test-owned полная closed matrix, скопированная из spec и не импортирующая runtime
   policy/URL validator; test-only build page проводит через boundary каталог hostile
   matrix-complement fixtures, чтобы oracle измерял фактический output, а не отсутствие
   payload в текущих данных;
2. expected registry `sink-id → production/demo paths/counts`: ноль областей,
   пропавший marker или sink-id — ошибка;
3. уникальные hostile canary tokens ищутся по всему `dist` и `dist-demo`, включая зоны
   вне marker-а; тот же прогон обязан в каждой сборке найти ровно один inert
   fixture-control token и ожидаемый sink marker на точном test-only path, иначе это
   vacuous failure;
4. whole-document hazard scanner независимо от marker-ов отвергает event attributes,
   `srcdoc`, XML/XLink URL, forbidden schemes и любой неинвентаризированный element,
   создающий nested browsing context либо загружающий/исполняющий script, style, document
   или active foreign-content resource; это обобщение включает `frame`/`frameset`, а не
   только заранее названные теги.

Source provenance проверяется отдельно от output. Source AST inventory хранит для каждого
executable-producing slot точный template/config path, node kind, structural locator/
fingerprint и ожидаемую identity; CI требует one-to-one соответствие committed slots и
поддерживаемых AST nodes. Output occurrence ссылается на slot ID, но не притворяется, что
DOM способен доказать свой source. Поэтому замена разрешённого node неизвестным mechanism
падает на missing/changed AST slot, даже если route, placement, count и identity не
изменились.

Executable registry дедуплицирует identity многочисленных `script`/`style` как global
body hash либо external asset identity с security attrs, но не использует identity set
как разрешение. Каждый occurrence привязан к stable source slot/template path, route
pattern, placement относительно stable anchor, identity и допустимому count на document;
элемент обязан совпасть ровно с одним rule. Поэтому дубликат разрешённого script из
неизвестного sink-а падает, хотя identity set не меняется. Для редких high-risk elements
те же route/count/placement обязательны. Явно запускаемый generator строит candidate
manifest из source AST inventory и built output в чистом worktree из назначенного
reviewed source SHA; reviewer сверяет source diff и manifest diff до commit. Обычный CI
только читает committed registry и никогда не перезаписывает его из текущего `dist`.

Негативные мутации обязательны как минимум для runtime allowlist extension при включённом
hostile build fixture, удаления marker-а, вывода canary вне отмеченного subtree,
пропажи fixture-control, parser-differential mXSS, self-removing script, refresh/resource
attempt, замены source slot при неизменном output, динамического неизвестного sink-а с
другим активным payload, discovery zero-match/unlisted field и пропавшей migration row.
Минимальный denylist отвергнут: он не может доказать закрытый allowlist и даёт
common-mode/vacuous failure.

### 10. Пересечения с активными changes

Код `architecture-frame-prototypes`, включая preview sink-и, уже находится на базовом
SHA и входит в baseline registry; условного «если приземлится» больше нет.
`online-payment-flow` пересекается через `oplata.astro`, но не меняет cleaner. Выбранный
sanitizer dependency и его проверки согласуются с `dependency-update-gates` перед merge.
С `dependabot-auto-merge` пересечение нормативное: machine registry фиксирует sanitizer,
DOM/parser stack, browser-oracle tooling и транзитивные parser lockfile nodes; изменение
любого из них является deny-only override поверх разрешающей таблицы и остаётся ручным.
Security headers/CSP не пересекаются с renderer code и остаются отдельным change.

## Risks / Trade-offs

- [Миграция SVG/style изменит текущий вид] → source mapping, computed-style assertions и
  сохранённые screenshots на каждой затронутой странице.
- [Responsive images будут ошибочно удалены] → base/derivative fixtures и проверка
  каждого manifest width против реального файла.
- [Runtime token будет подделан] → module-private Symbol, untrusted terminal mode,
  source cast gate и hostile component fixture.
- [Новая sanitizer/parser зависимость уязвима] → exact version/integrity, maintenance/
  provenance review, разбор каждого advisory независимо от severity и fail-closed
  security registry, исключающий direct/transitive subtree из Dependabot auto-merge.
- [Test oracle разойдётся с runtime policy] → это намеренная независимость; изменение
  нормативной spec требует явной синхронной правки обеих реализаций и negative mutation.
- [Появится принципиально новый raw API] → source collector не обещает распознать любой
  синтаксис, но whole-document hazard scanner независимо ловит активный результат;
  dependency/config diff review и расширение source registry остаются обязательными.

## Migration Plan

1. На точном базовом SHA зафиксировать source registry, raw-sink registry и rendered
   marker inventory; отдельно сохранить SVG/style/media migrations и fingerprints.
2. В отдельной чистой test-only сессии написать/обновить только тесты, предъявить RED и
   каждую предусмотренную негативную мутацию.
3. Другой исполнитель сначала выполняет content migrations, затем добавляет limits,
   policy, runtime-authenticated object и центральный sink, после чего мигрирует весь
   текущий registry потребителей.
4. Выполнить unit/component tests, production/demo builds, independent output oracle,
   typecheck/lint/audit и ручную RUTUBE-проверку с сохранённым свидетельством.
5. Провести два независимых code review, исправить подтверждённые находки, повторить
   negative verification и все гейты.
6. Согласовать пересечения `online-payment-flow`/`dependency-update-gates`/
   `dependabot-auto-merge`, получить приёмку владельца и только затем архивировать change.

Operational rollback после будущего подключения CMS не является требованием этой
capability. До такого подключения отдельный deployment-security change должен назвать
реальный enforcement point, проверку и evidence; документация без гейта не считается
выполнением renderer spec.
