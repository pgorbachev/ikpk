## Why

Rebuild вставляет legacy rich HTML через `set:html`, но общий конвейер
`cleanBodyHtml()` является нормализатором, а не санитайзером: исполняемые теги,
event-handler атрибуты, опасные URL-схемы и произвольные embed проходят без изменений.
Текущий JSON-снимок защищён ручным review в Git, однако будущая CMS и повторяемый импорт
уберут эту границу доверия. Поэтому инвариант безопасности должен появиться до
подключения любого из этих источников.

## What Changes

- Добавляется одна fail-closed граница санитизации после legacy-нормализации и до любой
  вставки rich HTML через `set:html`.
- Вводится явный allowlist элементов, атрибутов и URL-схем: неподдерживаемая разметка
  удаляется, а безопасный текст по возможности сохраняется.
- Блокируется исполняемый контент: scripts, активные embed-теги, inline event handlers,
  `srcdoc`, небезопасные стили, `javascript:` и активные `data:` URL.
- Сохраняется единственный намеренный embed — HTTPS-player RUTUBE на утверждённом
  hostname с фиксированными sandbox/referrer permissions, которые автор не может
  ослабить.
- Source discovery сверяет точный baseline selector list со всеми entity JSON и каждым
  CMS `type: richtext` attribute, включая пустые поля;
  singleton central sink и два точных JSON-LD исключения проверяются AST-гейтом.
  Независимые browser-conformant built-output гейты запрещают vacuous green, ищут hostile
  canary и любой неинвентаризированный активный output во всём production/demo document.
- До изменения раздельно фиксируются source-corpus (включая поля, которые текущий route
  extractor не выводит) и rendered-corpus. Characterization сохраняет структуру,
  доступность, media, responsive derivatives и визуально значимое оформление.
- Текущие content-origin inline SVG и inline styles мигрируются по закрытому mapping в
  spec; детерминированный manifest с entity ID/JSON path и точной заменой проходит review
  до RED-тестов.
- Единственный текущий внешний image URL переписывается на уже существующий локальный
  asset; новые внешние изображения удаляются, а отсутствующий локальный asset валит
  сборку.
- **BREAKING (контракт контента):** неподдерживаемые теги, атрибуты, embeds и URL-схемы
  больше не рендерятся, даже если они присутствуют в импортированном или CMS-контенте.

## Capabilities

### New Capabilities

- `rich-content-safety`: контракт безопасности и сохранения для каждого не-JSON-LD
  HTML-фрагмента, вставляемого через `set:html`.

### Modified Capabilities

<!-- Нет: принятые main specs пока не определяют рендеринг legacy/CMS rich HTML. -->

## Impact

- `web/src/lib/html-cleaner.ts`, wrapper в `web/src/lib/data.ts` и центральный
  `RichContent` sink образуют единую границу доверия rich content.
- Покрывается машинный реестр не-JSON-LD raw sinks в `web/src/pages/` и
  `web/src/components/`; JSON-LD остаётся под `serializeJsonLd()`.
- `web/package.json` и `web/package-lock.json` получают поддерживаемый серверный HTML-
  санитайзер и типы, если выбранный пакет их не содержит.
- `discovery/entities/course_groups.json` получает ссылку на уже существующий локальный
  `/media/uploads/0acd713c-...webp`; media manifest не требует нового entry.
- Текущие fragments с inline SVG/style и связанный CSS/media output получают явную
  миграцию, подтверждённую source/rendered fingerprints и visual evidence.
- Unit-тесты проверяют политику и устойчивость к мутациям; build-тесты анализируют
  фактически сгенерированные страницы, а не только возврат helper-а.
- Import scripts и Strapi permissions остаются отдельными security changes: эта работа
  делает их будущий HTML безопасным на границе рендера, но не превращает ingestion path
  в доверенный.
