## 1. В отдельной чистой test-only сессии зафиксировать baseline evidence

- [ ] 1.1 На SHA `2d48e84db36c013fabcbbe9ba389e1f4debca639` построить test-owned машинный source registry по точному selector list spec; независимым обходом всех entity JSON/CMS schema падать на `_html`/parsed-element/`type: richtext` field вне списка и на selector без registry entry, явно включая `video_playlists[*].description_html` и пустые CMS richtext attributes.
- [ ] 1.2 Сохранить raw-sink registry из Astro/TypeScript AST и rendered registry `sink-id → production/demo paths/counts`; JSON-LD классифицировать отдельно под существующим `serializeJsonLd()` invariant.
- [ ] 1.3 Построить source fingerprint и rendered fingerprint: текст/порядок блоков, headings, lists, tables, `time[datetime]`, links, base/derived images, `details`, inert checkbox/label, system markers, RUTUBE, SVG/style mappings и marker inventory.
- [ ] 1.4 До sanitizer RED-тестов сгенерировать и отревьюить test-owned migration manifest по закрытому mapping spec: для каждого SVG/mapped declaration, включая payment flex/spacing, сохранить selector, stable entity ID/JSON path, исходный context/value, точный replacement class/text, accessible name и route либо `source-only`; gate обязан доказать полноту против независимого discovery.
- [ ] 1.5 Зафиксировать, что локальный `/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp` и manifest entry уже существуют, а known deviation — только remote URL в `course_groups.json`.
- [ ] 1.6 Сверить пересечения: preview sink-и `architecture-frame-prototypes` уже входят в base; `online-payment-flow` пересекается через `oplata.astro`, но не меняет `normalizeLegacyControls()`; dependency review согласовать с `dependency-update-gates`.
- [ ] 1.7 В этой же test-only сессии негативно проверить оба новых baseline gate: zero-match input glob и добавленный unlisted `_html`/CMS `type: richtext` field валят discovery; удалённая строка mapped SVG/style валит manifest completeness. Сохранить красный вывод, вернуть мутации и подтвердить зелёный baseline без изменений production-кода.

## 2. В той же test-only сессии написать и предъявить RED-тесты

- [ ] 2.1 Для каждого scenario spec добавить автоматический тест либо явную причину ручной проверки и формат evidence; отдельно доказать coverage source-only RUTUBE и каждого field из нормативного selector list.
- [ ] 2.2 Добавить unit-матрицу closed tags/attributes: active discard-with-content, recursive sanitize+unwrap для inert unknown wrappers, `on*`, `style`, XML/XLink, `time`, inert checkbox/label и точные structural system markers, включая `data-safe-rich-content`.
- [ ] 2.3 Добавить reserved-marker fixtures: поддельные markers/classes удаляются в untrusted mode, authenticated output сохраняет только table-wrapper, resolved CTA и unresolved CTA forms.
- [ ] 2.4 Добавить URL/media fixtures: entities/control chars, credentials confusion, anchor schemes, base manifest assets, разрешённые `/media/_w/<width>/**` derivatives, mixed/external `srcset`, strip external/forbidden image src и fail-build для missing/noncanonical local src (`/images/**`, `../**`, derivative в `src`).
- [ ] 2.5 Добавить точные тесты `target`/`rel` и RUTUBE origin/path/permissions, включая похожие hosts, port, credentials, query/fragment и author sandbox override.
- [ ] 2.6 Добавить oversized/deep/wide fixtures для 2 MiB, 50 000 nodes, depth 256, а также malformed fixture с единственным ожидаемым browser-conformant recovered+sanitized DOM и безопасное сообщение resource error с source type/ID без исходного HTML.
- [ ] 2.7 Расширить source collector: разрешать Astro `set:html` только в singleton `RichContent.astro` и точных JSON-LD `HeadMeta.astro`/`Breadcrumbs.astro`, запретить остальные `set:html`, `is:raw` и literal/expression/spread `srcdoc`; в TypeScript сверять raw-sink registry, четыре точных `innerHTML = ''`, запрещать внешние SafeRichHtml casts/construction и не заявлять catch-all неизвестного синтаксиса.
- [ ] 2.8 Добавить component render tests для authenticated результата, обычной строки, поддельного runtime token и hostile payload непосредственно перед `set:html`.
- [ ] 2.9 Добавить test-owned полный oracle closed matrix, включая точные system-marker forms, без импортов runtime policy/URL validator и с browser-conformant parser-ом, независимым от runtime parser-а; test-only page покрывает matrix-complement, misnested, foreign-content и entity mXSS, marker inventory падает при нуле, пропавшем sink-id или path.
- [ ] 2.10 Добавить whole-dist canary scan `dist` и `dist-demo`: hostile tokens ищутся в любой области, а ожидаемый test-only path обязан в каждой сборке того же прогона содержать ровно один inert fixture-control token и sink marker; отсутствие/дубликат — ошибка.
- [ ] 2.11 Добавить whole-document hazard scanner и test-owned executable registry: общий detector ловит любой nested-browsing-context/active-resource element, включая frame/frameset; script/style сверяются по global unique body hash/asset identity, а редкие high-risk elements — ещё по route/count/placement. Добавить явный generator candidate manifest из назначенного reviewed SHA; CI не обновляет registry из текущего `dist`.
- [ ] 2.12 Явно согласовать существующие `html-cleaner.test.ts`: сохранить label/checkbox как disabled inert control, а remote-image fixture локализовать до boundary либо изменить ожидание на безопасное удаление; предъявить RED относительно нового contract.
- [ ] 2.13 Предъявить контролируемые негативные мутации: зарегистрированный внешний `set:html`, Astro `srcdoc` в literal/expression/spread формах, runtime allowlist extension, parser differential, удаление marker-а, canary вне marker-а, пропавший fixture path/control token, frame/frameset и неизвестный динамический sink с отличным активным payload, поддельный token, missing/noncanonical local media и сохранённый system marker; затем вернуть production-код неизменённым.

## 3. Реализовать границу безопасности другим исполнителем

- [ ] 3.1 Выполнить content migrations: переписать known remote image URL на существующий local asset, заменить content-origin inline SVG по mapping и перенести все mapped inline styles, включая `/oplata` flex/spacing, в конечные локальные classes.
- [ ] 3.2 Выбрать maintained server-side sanitizer/parser, который проходит browser-conformant tree-construction fixtures и остаётся независим от output oracle; проверить Node compatibility, limits, maintenance/provenance и каждый advisory subtree, зафиксировать exact version/integrity в `web/package-lock.json`.
- [ ] 3.3 Реализовать byte/node/depth/output limits и source-aware ошибки до legacy regex-проходов.
- [ ] 3.4 Реализовать untrusted pre-scrub, closed matrix, URL/media transforms и два terminal trust mode; `SafeRichHtml` сделать runtime-authenticated объектом с module-private token/factory.
- [ ] 3.5 Реализовать base/derivative media validation, точную RUTUBE reconstruction, target/rel normalization и idempotence terminal sanitizer для каждого trust mode.
- [ ] 3.6 Добавить `RichContent.astro`, проверяющий runtime token, повторно санитизирующий непосредственно у `set:html` и ставящий стабильный `data-safe-rich-content="<sink-id>"`.
- [ ] 3.7 Перевести каждый consumer из актуального raw-sink registry на центральный компонент с stable sink/source IDs, сохранив CSS hooks, test selectors и layout; JSON-LD оставить под `serializeJsonLd()`.
- [ ] 3.8 Подключить source registry gate, independent browser-conformant output oracle, marker inventory, whole-dist canary и whole-document hazard scanner к обязательным production/demo local и CI checks; generator executable manifest оставить только явной maintainer-командой, не CI side effect.

## 4. Проверить поставку

- [ ] 4.1 Добиться зелёного `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:build` и `npm run test:demo` в `web/`.
- [ ] 4.2 Выполнить `npm run audit:prod`, разобрать все advisory sanitizer/parser subtree с risk acceptance только по явному решению владельца и подтвердить отсутствие sanitizer-а в browser bundle.
- [ ] 4.3 Сравнить source/rendered fingerprints, подтвердить полноту marker inventory и сохранить screenshots/computed-style evidence для каждой SVG/style migration page, включая layout `/oplata`.
- [ ] 4.4 Вручную проверить source-only RUTUBE fixture на изолированном стенде с точными sandbox/allow/referrer attributes; сохранить URL, вывод и screenshot.
- [ ] 4.5 Повторить все негативные мутации 1.7 и 2.13 на реализации, доказать ожидаемые падения, вернуть мутации и повторить полный зелёный прогон.

## 5. Независимое ревью и приёмка

- [ ] 5.1 Провести независимое security review соответствия реализации каждому requirement/scenario, включая trust modes, media derivatives, whole-dist canary и whole-document hazard scanner; исправить подтверждённые находки.
- [ ] 5.2 Провести независимое compatibility review source/rendered corpora, SVG/style migrations, существующих cleaner-тестов и полноты sink registry; исправить подтверждённые находки.
- [ ] 5.3 После исправлений повторить раздел 4 и зафиксировать точный SHA проверенной реализации и evidence paths.
- [ ] 5.4 Обновить пересекающиеся active changes относительно нового sink contract и доказать строгую применимость их delta specs.
- [ ] 5.5 После приёмки владельцем архивировать change и проверить перенос `rich-content-safety` в main specs.
