# Article SEO fallbacks: pre-implementation test evidence

Base revision: `0f786367874a054f8b61b29cc4ea15f1ab026c54`; test branch head before this evidence refresh: `e3628138a95fc814c1525f428ed8715cb4ec57af`.

All red behavior tests use current public entry points: both CMS publication validators, registered CMS lifecycle middleware, and live capture via the existing HTTP CMS stub. No production exports or implementation files were added.

## CMS validator and lifecycle RED

Exact command: `node --experimental-strip-types --experimental-loader=./scripts/ts-extension-loader.mjs --test tests/article-seo-publication-fallbacks.red.test.js (cwd: cms/)`.

```text
(node:73288) ExperimentalWarning: `--experimental-loader` may be removed in the future; instead use `register()`:
--import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/ts-extension-loader.mjs", pathToFileURL("./"));'
(Use `node --trace-warnings ...` to show where the warning was created)
✖ CMS and scripts validators accept absent or blank Article SEO only, preserving other required fields (2.219709ms)
✖ CMS lifecycle publishes nested SEO omission or partial values without deriving or persisting defaults (0.59725ms)
✖ CMS lifecycle does not require the web sanitizer to leave a description fallback (0.081625ms)
✔ publication validates the persisted nested SEO component after a partial update payload (0.101125ms)
(node:73288) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///private/tmp/ikpk-article-seo-fallback-red-20261117/cms/tests/article-seo-publication-fallbacks.red.test.js is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /private/tmp/ikpk-article-seo-fallback-red-20261117/cms/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
ℹ tests 4
ℹ suites 0
ℹ pass 1
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1260.118042

✖ failing tests:

test at tests/article-seo-publication-fallbacks.red.test.js:24:1
✖ CMS and scripts validators accept absent or blank Article SEO only, preserving other required fields (2.219709ms)
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
✖ CMS lifecycle publishes nested SEO omission or partial values without deriving or persisting defaults (0.59725ms)
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
✖ CMS lifecycle does not require the web sanitizer to leave a description fallback (0.081625ms)
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

## CMS capture normalization RED

Exact command: `npx vitest run tests/cms-live-snapshot-capture.test.ts -t "Article SEO fallbacks through live snapshot capture" (cwd: web/)`.

```text

 RUN  v4.1.11 /private/tmp/ikpk-article-seo-fallback-red-20261117/web

 ❯ tests/cms-live-snapshot-capture.test.ts (59 tests | 1 failed | 57 skipped) 1244ms
     × normalizes each field independently and derives a 200-character visible-text excerpt 554ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/cms-live-snapshot-capture.test.ts > Article SEO fallbacks through live snapshot capture > normalizes each field independently and derives a 200-character visible-text excerpt
AssertionError: capture failed:

/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/lib/content-contract.ts:257
  throw new Error(`контракт снимка нарушен: ${violations.length} — ${summary}. Примеры: ${examples}`);
        ^

Error: контракт снимка нарушен: 3 — articles.page_title required-field-empty ×1; articles.page_description required-field-empty ×1; articles.seo_description required-field-empty ×1. Примеры: art-001, art-001, art-002
    at assertSnapshotContractCore (/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/lib/content-contract.ts:257:9)
    at assertSnapshotContract (/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/lib/content-contract.ts:262:3)
    at assertCaptureSnapshotContract (/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/lib/capture-snapshot-contract.ts:24:5)
    at liveCapture (/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/capture-content-snapshot.ts:697:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (/private/tmp/ikpk-article-seo-fallback-red-20261117/web/scripts/capture-content-snapshot.ts:740:3)

Node.js v24.13.0
: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ assertSnapshotContractCore scripts/lib/content-contract.ts:257:9
 ❯ assertSnapshotContract scripts/lib/content-contract.ts:262:3
 ❯ assertCaptureSnapshotContract scripts/lib/capture-snapshot-contract.ts:24:5
 ❯ liveCapture scripts/capture-content-snapshot.ts:697:3
 ❯ <anonymous> scripts/capture-content-snapshot.ts:740:3
 ❯ tests/cms-live-snapshot-capture.test.ts:500:60
    498|     try {
    499|       const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHO…
    500|       expect(run.status, `capture failed:\n${run.output}`).toBe(0);
       |                                                            ^
    501|       const captured = typesOf(readSnapshot(dir)).articles!;
    502|       const renderedTree = cleanBodyHtml(sourceBody, { type: 'article'…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 57 skipped (59)
   Start at  10:10:27
   Duration  2.28s (transform 156ms, setup 23ms, import 874ms, tests 1.24s, environment 0ms)


EXIT_STATUS=1
```

## CMS capture no-visible-text check

Exact command: `npx vitest run tests/cms-live-snapshot-capture.test.ts -t "refuses a snapshot when sanitization" (cwd: web/)`.

```text

 RUN  v4.1.11 /private/tmp/ikpk-article-seo-fallback-red-20261117/web


 Test Files  1 passed (1)
      Tests  1 passed | 58 skipped (59)
   Start at  10:07:49
   Duration  802ms (transform 133ms, setup 20ms, import 227ms, tests 424ms, environment 0ms)


EXIT_STATUS=0
```

## Built metadata and sanitizer baseline

Exact command: `npx vitest run tests/article-seo-publication-fallbacks.red.test.ts (cwd: web/)`.

```text

 RUN  v4.1.11 /private/tmp/ikpk-article-seo-fallback-red-20261117/web


 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  10:10:27
   Duration  12.52s (transform 143ms, setup 23ms, import 809ms, tests 11.54s, environment 0ms)


EXIT_STATUS=0
```

## Coverage delivered

- CMS validation-copy parity across both missing, whitespace-only, and each partial override; existing non-SEO required fields and non-Article SEO requirements remain guarded.
- CMS lifecycle with nested `seo.seo_title` / `seo.seo_description` omitted, null, empty, and partial. Generated values are asserted not to be persisted. A separate green characterization passes a partial nested update payload while validating the fetched full persisted component; this does not emulate Strapi's database merge itself.
- Actual CMS-to-site capture asserts fallback generation for both missing fields, independent partial overrides, blank values, 200-character visible-text cap, explicit long description preservation, and excerpt equality with actual `cleanBodyHtml` rendered text (entities, script/style removal, stripped hidden attributes). This test is red before implementation because capture currently rejects at its snapshot contract.
- Actual capture with a body sanitized to no text and no explicit description is refused, identifies the article/description, and writes no snapshot. It passes on the base implementation.
- A separate isolated Astro build checks fallback and explicit override values in `<title>`, description and OG metadata, and JSON-LD. It passes on the base renderer.

## Remaining composed coverage / structural evidence

The CMS no-text capture test stops before the publication runner, so it does not assert the active site pointer in the same end-to-end test. The existing structural boundary is: live capture calls `assertCaptureSnapshotContract` before writing `snapshot.json` (`web/scripts/capture-content-snapshot.ts:695-702`); publication `runChecks` completes before the transport is created/staged (`web/scripts/lib/publication-runner.ts:69-70`, 150-153); and the transport regression `scripts/tests/publication-transport.test.mjs:514-530` proves a refusing pre-activation check leaves `current` on `old`. Together they show the architecture of refusal-before-activation, but the article-specific no-description failure is not composed through the active-pointer transport in one test.

The partial-update test uses the real registered lifecycle entry point but a fake persisted document; actual Strapi database component merge semantics are not exercised in this no-server test session. No server or production was contacted.
