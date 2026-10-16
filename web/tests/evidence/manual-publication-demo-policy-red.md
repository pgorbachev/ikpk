# DEMO publication-only RED behavior evidence

Runtime under test: PR #332, `feat/server-release-command`, full base SHA
`b44a47a179d8abaf1abe790022a269ffffd9cf9f`. Only tests and a destination parameter for
the existing rollback fixture were changed. No publisher implementation or specification changed.

From `web/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx vitest run tests/manual-publication-demo-policy.test.ts tests/publication-state-store.test.ts -t 'DEMO|legacy without provenance|production without provenance' --reporter=json --outputFile=/private/tmp/ikpk-demo-policy-red-result.json
```

Observed exit 1: **36 selected tests, 25 failed, 11 passed**; 31 unrelated state-store
tests skipped by the name filter. Failures are runtime assertions, not missing imports:

- Protected configuration accepts wrong host, origin, deploy mode, either non-ci payment
  role, and an unknown policy instead of refusing (six failures).
- The approved `server-db` snapshot is rejected as `unverified live snapshot identity`;
  positive publication, changed-tree, serving-failure and index-failure scenarios consequently
  cannot reach the intended DEMO path (four failures).
- Pure selection rejects a no-revision DEMO pair as `content-newer-than-verified-pair`.
  Its five group, five CI and digest checks assert the existing specific refusal codes,
  so they will verify those gates after DEMO becomes usable. Conversely, adding forged
  journal revision 4 currently produces `publish` (thirteen failures together).
- Retained DEMO rollback rejects the original no-revision record as
  `no verified original retained publication` (one failure).
- The real local Git state store rejects a no-revision publication-snapshot as
  `invalid publication evidence` (one failure). The scenario requires append-only
  preservation of three existing events, HWM 3 and two historical stand pairs, plus an
  idempotent retry of the same publication ID.

The eleven passing checks include legacy/production fail-closed behavior with no
provenance, omitted-policy preservation, independent dev-profile authorization, pending
destination refusal, moved-head refusal and malformed DEMO capture rejection. These negative
capture cases alone do not prove the new verifier: the positive capture test is still RED.

The trusted fixture `runChecks` result uses the agreed public metadata:
`sourcePolicy=demo-publication-only`, `sourceAge=untracked`, origin kind `server-db` with
source ID `demo193-cms`, and the version-1 `quiesced-sqlite-backup` capture proof bound to
the publication ID. It has no provenance/revision/HWM. Digest strings in this unit fixture
stand for the installed capture adapter's already verified result; this test does not
prove SQLite quiescence, media capture, bundle verification or the OS supervisor. Those
belong to the capture implementation's own integration tests. No new serving-proof schema
or broad CLI harness is prescribed here; the existing serving verifier must still run
under the host lock before the index append.

Validation: changed-file ESLint passed; `npm run typecheck` passed (0 errors, 9 existing
hints). An exploratory unfiltered state-store run also encountered two existing 20-second
timeouts in journal mismatch/concurrent-writer scenarios; these are outside the selected
DEMO contract, and are not counted as intended RED failures above. No network/service writes,
push, merge or PR comments were performed.
