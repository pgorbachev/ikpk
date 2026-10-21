# Review record

Date: 2026-10-21

## Provenance and roles

- Reviewed draft content digest: `1dc0db8928c94ce43b22305f1c5e8225058738e68b8637e5339e824405645815`. This digest identifies the earlier reviewed content only; it is not a Git object or revision ref.
- Base: origin/main at `2fee597b5335f6c61fd61a622fa2a5f3f475a605`.
- Author of earlier draft: Luna, explicitly delegated by the user.
- Earlier review: two independent full spec-review passes by separate reviewer roles using Astra. The draft had unresolved findings; those passes do not constitute approval of the current planning revision.

## Earlier findings

- **P2 — factual reference, corrected in the earlier draft:** `.toEqual([]);` is at `web/tests/external-widgets.spec.ts@2fee597b5335f6c61fd61a622fa2a5f3f475a605:433`, `).toEqual([]);`.
- **P2 — verification plan, corrected in the earlier draft:** `npm run test:build` and a non-demo widget probe are scheduled in the earlier task plan.
- **P1 — placement blocker, historically open:** the prior revision had not selected how a permanently visible 52px capsule would coexist with dense mobile content. Its mockup was not sufficient to decide placement. This finding records that earlier state; the independent passes did not read the 21.10 revision.

## Owner decision and current status

On 2026-10-21 the owner selected `Внизу в свободной зоне` from the saved comparison mockup. The chosen contract is a 52 CSS px labelled capsule at right in a separate 80 CSS px lower zone, with the page content in a real scrollport above it. This closes the placement choice as a planning decision; the preserved HTML mockup and updated notes record the choice.

The owner fully approved the current proposal, design, and delta spec on 2026-10-21 after the independent reviews below. This does not close production TD-52, implementation, or acceptance. No code, product tests, deployment, commit, or publication was performed in the planning update.

## Findings on the current planning revision

- **P2 — verification sequence and concrete commands:** root and Astra both confirmed that the previous revision had dropped the existing `lint`, `typecheck`, `test:build` and `test:e2e:widgets` commands and the requirement to run a fresh `test:build` before Playwright, which could inspect stale `dist`. Those commands, their order, and the separate non-demo preview-role probe that must expose both chat and payment dialog are restored in `tasks.md`.
- **P2 — required complexity review step:** root found that the previous revision omitted the separately requested read-only `/ponytail-review` step. Step 5b is restored in `tasks.md` with the required list of removals or standard replacements and reasons for rejected suggestions.

Root and Astra each completed a full pass on the current proposal/design/delta-spec revision. After the checklist-only corrections, both performed a proportionate repeat check of `tasks.md` and this review record: the findings above are closed and no new P0, P1, or P2 findings were reported. Full owner approval of the revised specification was received on 2026-10-21.

## Revision fingerprints

These SHA-256 digests identify the unchanged normative planning artifacts reviewed in both full passes:

- `proposal.md`: `b886da5a09189e71c2cf702e876c27bcf9aecd19081fbbd5ae65848c2ef26740`
- `design.md`: `8c3936c3159d7730b02f0d66a3a22ab179f19ef91c4aae439878930826e213c0`
- `specs/external-widgets/spec.md`: `f15958997a4d7e3190d1b30a1b071b9fddde5bbcdd40ed26e419ed6c7c29a25a`

## Earlier gate evidence

- Earlier draft: `./bin/openspec validate chat-entry-visibility --strict` exit 0.
- Earlier `./bin/check-spec-refs` initially exited 1 for the citation at line 432; the citation was corrected to line 433 and the author's subsequent reference-check run exited 0 before this status-only update. Root's sandbox attempt exited 2 before scanning references because nested OpenSpec status lacked schema metadata; this was not a reference-check result. The final network-enabled `./bin/check-spec-refs` run exited 0: расхождений 0, поимённый долг 105/105 без прироста.
- Root's current strict OpenSpec validation exited 0. Root's whitespace check across all six Markdown files exited 0.
