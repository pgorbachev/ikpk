# Article SEO fallbacks: pre-implementation test evidence

Base revision: `0f786367874a054f8b61b29cc4ea15f1ab026c54` (`codex/article-seo-fallback-proposal-20261117`).

## CMS red run

Exact command (working directory `cms/`):

```sh
node --experimental-strip-types --experimental-loader=./scripts/ts-extension-loader.mjs --test tests/article-seo-publication-fallbacks.red.test.js
```

Exit status: `1`. The three failing behavior tests are the direct validator parity/optional Article SEO cases, nested Article lifecycle cases, and CMS acceptance independent of sanitizer fallback availability. Output follows (experimental runtime warnings retained):

```text
(node:38763) ExperimentalWarning: `--experimental-loader` may be removed in the future; instead use `register()`:
--import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-extension-loader.mjs", pathToFileURL("./"));'
(Use `node --trace-warnings ...` to show where the warning was created)
✖ CMS and scripts validators accept absent or blank Article SEO only, preserving other required fields (2.54375ms)
✖ CMS lifecycle publishes nested SEO omission or partial values without deriving or persisting defaults (0.605042ms)
✖ CMS lifecycle does not require the web sanitizer to leave a description fallback (0.095792ms)
(node:38763) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/tests/article-seo-publication-fallbacks.red.test.js is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /private/tmp/ikpk-article-seo-fallback-red-20261117/cms/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
ℹ tests 3
ℹ suites 0
ℹ pass 0
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3448.667667

✖ failing tests:

test at tests/article-seo-publication-fallbacks.red.test.js:24:1
✖ CMS and scripts validators accept absent or blank Article SEO only, preserving other required fields (2.54375ms)
  AssertionError [ERR_ASSERTION]: Article SEO overrides are optional; rejected cases: [null,null]: не заполнены обязательные поля: seo_title, seo_description; ["   ",null]: не заполнены обязательные поля: seo_title, seo_description; ["Редакторский заголовок",""]: не заполнены обязательные поля: seo_description; ["","Редакторское описание"]: не заполнены обязательные поля: seo_title
  + actual - expected
  
  + [
  +   '[null,null]: не заполнены обязательные поля: seo_title, seo_description',
  +   '["   ",null]: не заполнены обязательные поля: seo_title, seo_description',
  +   '["Редакторский заголовок",""]: не заполнены обязательные поля: seo_description',
  +   '["","Редакторское описание"]: не заполнены обязательные поля: seo_title'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/tests/article-seo-publication-fallbacks.red.test.js:51:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at Test.start (node:internal/test_runner/test:1003:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:358:17)
      at process.processTicksAndRejections (node:internal/process/task_queues:103:5) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ '[null,null]: не заполнены обязательные поля: seo_title, seo_description', '["   ",null]: не заполнены обязательные поля: seo_title, seo_description', '["Редакторский заголовок",""]: не заполнены обязательные поля: seo_description', '["","Редакторское описание"]: не заполнены обязательные поля: seo_title' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/article-seo-publication-fallbacks.red.test.js:54:1
✖ CMS lifecycle publishes nested SEO omission or partial values without deriving or persisting defaults (0.605042ms)
  AssertionError [ERR_ASSERTION]: nested optional SEO rejected: undefined: не заполнены обязательные поля: seo_title, seo_description; null: не заполнены обязательные поля: seo_title, seo_description; {}: не заполнены обязательные поля: seo_title, seo_description; {"seo_title":"Редакторский заголовок"}: не заполнены обязательные поля: seo_description; {"seo_description":"Редакторское описание"}: не заполнены обязательные поля: seo_title
  + actual - expected
  
  + [
  +   'undefined: не заполнены обязательные поля: seo_title, seo_description',
  +   'null: не заполнены обязательные поля: seo_title, seo_description',
  +   '{}: не заполнены обязательные поля: seo_title, seo_description',
  +   '{"seo_title":"Редакторский заголовок"}: не заполнены обязательные поля: seo_description',
  +   '{"seo_description":"Редакторское описание"}: не заполнены обязательные поля: seo_title'
  + ]
  - []
  
      at TestContext.<anonymous> (file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/tests/article-seo-publication-fallbacks.red.test.js:64:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
      at async Test.run (node:internal/test_runner/test:1113:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:788:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 'undefined: не заполнены обязательные поля: seo_title, seo_description', 'null: не заполнены обязательные поля: seo_title, seo_description', '{}: не заполнены обязательные поля: seo_title, seo_description', '{"seo_title":"Редакторский заголовок"}: не заполнены обязательные поля: seo_description', '{"seo_description":"Редакторское описание"}: не заполнены обязательные поля: seo_title' ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }

test at tests/article-seo-publication-fallbacks.red.test.js:67:1
✖ CMS lifecycle does not require the web sanitizer to leave a description fallback (0.095792ms)
  Error [ApplicationError]: не заполнены обязательные поля: seo_title, seo_description
      at file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/src/lifecycles/publication.ts:368:17
      at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
      at async TestContext.<anonymous> (file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/tests/article-seo-publication-fallbacks.red.test.js:69:16)
      at async Test.run (node:internal/test_runner/test:1113:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:788:7) {
    details: {}
  }

EXIT_STATUS=1
```

## Web snapshot and sanitizer characterization

Exact command (working directory `web/`):

```sh
npx vitest run tests/article-seo-publication-fallbacks.red.test.ts
```

Exit status: `0`; all three checks passed. These are green baseline characterization/contract checks: normalized SEO-complete snapshots satisfy the current contract, an empty sanitized body without description is rejected, and the current sanitizer removes script/style while retaining visible text after it strips `hidden`/`aria-hidden`; parse5 text extraction decodes entities.

```text

 RUN  v4.1.11 /private/tmp/ikpk-article-seo-fallback-red-20261117/web


 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  09:55:46
   Duration  648ms (transform 206ms, setup 48ms, import 366ms, tests 14ms, environment 0ms)
```

## Scope gaps for implementation session

This test-only delivery does not yet exercise the capture pipeline's private record mapper, generated title/description values from actual CMS captures, the full 200-character/blank/partial/nonempty-body fallback matrix, or rendered built `<title>`/description/OG/JSON-LD values. It also does not model update-payload merge semantics independently of Strapi, nor the end-to-end failure preserving a previously active site publication. The sanitizer behavior is characterized against `cleanBodyHtml`; the fallback extractor itself does not exist as a testable API on the base revision. No production implementation was modified.
