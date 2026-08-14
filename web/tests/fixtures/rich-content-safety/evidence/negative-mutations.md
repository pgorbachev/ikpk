# Negative mutations 1.7 and 2.13

- Implementation SHA: `809cc14bf296a8184221ac9a6847642701467565`
- Mutation worktree: `/Users/pgorbachev/projects/private/ikpk-sanitize-rich-html-mut` (detached HEAD at that SHA)
- Restore check after each mutation: empty `git status --porcelain --untracked-files=no` and empty `git diff` vs SHA; dist canary HTML restored from backup copies.
- Vacuous first canary attempts (default vitest config excludes `*.build.test.ts`, `-t` skipped all tests with exit 0) are discarded. Valid canary runs use `vitest.build.config.ts`.

After the full set, restored worktree: `rich-content-baseline` + `rich-content-contract` 89 passed; `rich-content-canary.build` 4 passed.

## 1.7a default entitiesGlob → `*.no-such-json`

- Command: `perl -pi -e "s/opts.entitiesGlob \\?\\? '\\*\\.json'/opts.entitiesGlob ?? '*.no-such-json'/" web/tests/helpers/rich-content-safety/source-discovery.ts` then `npx vitest run tests/rich-content-baseline.test.ts -t 'живое discovery'`
- Before/after: default glob `*.json` → `*.no-such-json`
- Failed: `живое discovery совпадает с committed registry` (zero-match throw)
- Restored.

## 1.7b planted `_html` in `articles.json[0]`

- Before/after: no `planted_html` → `planted_html: "<p>planted</p>"`
- Command: `npx vitest run tests/rich-content-baseline.test.ts -t 'нормативный selector list'`
- Failed: `нормативный selector list покрыт registry, включая video_playlists и пустые CMS richtext`
- Restored.

## 1.7c CMS `type:richtext` `article.payload`

- Before/after: article schema without `payload` → `{ type: "richtext" }`
- Command: same as 1.7b
- Failed: `нормативный selector list покрыт registry, включая video_playlists и пустые CMS richtext`
- Restored.

## 1.7d delete first `migration-manifest.json` row

- Before/after: 1388 rows → 1387
- Command: `npx vitest run tests/rich-content-baseline.test.ts -t 'каждая SVG'`
- Failed: `каждая SVG и mapped style имеет строку manifest`
- Restored.

## 2.13 registered external `set:html`

- Mutation: append `<div set:html={html} />` to `web/src/pages/404.astro`
- Failed: `production set:html только в RichContent.astro и JSON-LD HeadMeta/Breadcrumbs`
- Restored.

## 2.13 Astro `srcdoc` literal

- Mutation: append `<iframe srcdoc="<p>x</p>"></iframe>` to `404.astro`
- Failed: `запрещает is:raw и srcdoc во всех формах`
- Restored.

## 2.13 runtime allowlist extension

- Mutation: move `script` from `DISCARD` to `ALLOWED` in `rich-html-sanitize.ts`
- Failed: `активный script удаляется вместе с содержимым`
- Restored.

## 2.13 shared parser engine

- Mutation: add `parse5` to oracle packages in `security-dependency-registry.json`
- Failed: `runtime sanitizer зарегистрирован, lockfileNodes fail-closed и не делит parser engine с oracle`
- Restored.

## 2.13 forged `SafeRichHtml` cast

- Mutation: `const forged = { html: "<p>x</p>" } as SafeRichHtml` in `web/src/lib/data.ts`
- Failed: `четыре точных innerHTML = '' и никаких иных TS raw sinks`
- Restored.

## 2.13 duplicate approved source slot

- Mutation: duplicate first slot in `executable-source-slots.json` with new locator
- Failed: `дубликат approved script с тем же identity и другим locator валит provenance`
- Restored.

## 2.13 missing fixture-control token

- Mutation: strip `rc-fixture-control-9f3c2e1a` from `dist/rich-content-canary/index.html` (count 1 → 0)
- Command: `npx vitest run --config vitest.build.config.ts tests/rich-content-canary.build.test.ts`
- Failed: `ожидаемый test-only path содержит ровно один control token и sink marker`
- Restored from backup.

## 2.13 canary outside marker

- Mutation: insert `rc-hostile-canary-7b41d0ee` before `</body>` in dist canary HTML
- Failed: `hostile canary отсутствует во всём dist, и dist не пуст`
- Restored from backup.

## 2.13 removed sink marker

- Mutation: strip `data-safe-rich-content="canary-body"` from dist canary HTML
- Failed:
  - `ожидаемый test-only path содержит ровно один control token и sink marker`
  - `каждая ожидаемая область имеет data-safe-rich-content, count совпадает, лишних route нет`
- Restored from backup.

## In-memory 2.13 fixtures (not re-applied as file mutations)

These plant the unsafe input inside the test and remain assertions on the implementation SHA (`npm test`: 475 passed):

- `srcdoc` expression/spread: `ловит srcdoc %s`
- parser differential / mXSS / self-removing script / refresh / subresource: `web/tests/rich-content-oracle.test.ts`
- frame/frameset: `frame и frameset удаляются вместе с содержимым`
- PDF-as-img, mixed external+missing derivative, descriptor mismatch, missing/noncanonical local media: corresponding tests in `rich-content-contract.test.ts`
- forged token at `RichContent`: `web/tests/rich-content-render.test.ts`
- preserved system marker / reserved markers: reserved-marker tests in `rich-content-contract.test.ts`
