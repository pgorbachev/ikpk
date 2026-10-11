# D4 review remediation: RED evidence

Ran before production changes on `954d404712d1e402cc047f18907f1c97f8e7ed3a` after adding the regression assertions.

`cd scripts && npm exec vitest -- run lib/person-trait-import.test.ts`

- Exit 1; 1 failed, 2 passed.
- The existing-record upgrade assertion failed: `UPDATE 80 не восстановил первичную классификацию: expected undefined to be 'method-author'`.
- The existing CREATE classification and non-empty administrator override assertions passed.

`cd web && npm exec vitest -- run tests/cms-live-snapshot-capture.test.ts`

- Exit 1; 2 failed, 30 passed.
- A live teacher with `trait: null` was accepted with exit code 0 and a written snapshot.
- An institute relation with `slug: 'new-inst'` and `legacy_id: null` failed snapshot validation with seven `broken-relation` violations.

`cd web && npm run test:build -- tests/cms-catalog-pages.build.test.ts`

- Exit 1; 1 failed, 17 passed after the real static site build completed.
- The actual built catalog's source snapshot had no `method-author` IDs; expected IDs were `80,79,77,74,71,70,69,68,67,66,65`, received `[]`.
- This output exposed why checking headings alone had passed while both rendered groups and the roster were empty.
