# Offline seminar content rehearsal

These tools create a **local copy only**. They are not a release runner, do not connect to Strapi, do not establish permission to deploy, and do not verify the original source of the sidecar or editorial currency of document facts. Inputs, outputs and receipt contain full content; keep them private. The supplied report covers one pinned sidecar (`db77136e25d403c16d0d38b488578a92adcf0b8361b5c2b1afa9dac52346e8ff`), and assumes the site's `localizeAssetUrls`, `stripLegacySeminarTail`, `cleanBodyHtml`, `terminalSanitize` and current Astro page. Any code, data, route, sidecar, schema, document proposal or renderer change invalidates the evidence; regenerate and review it.

The input JSON is an array `{source: {...}}` with each physical row's `id`, `document_id`, `locale`, `version`, canonical `path`, `description`, `full_text`, `learning_plan`, `learning_mode`, and `recommendations`. The second audit uses the current page, a separately reviewed v7 document proposal, and the real Astro renderer to compare section content, selected semantic elements, links, image alt and source, and IDs; document facts are rewritten structurally, so their semantic correctness still requires independent per-group review. It also compares existing separate CMS fields against the actual page and verifies reconstructed legacy output. Links that appear multiple times due to splitting independent document conditions are allowed only when each original reference remains in order.

`rehearse.py` independently checks the source row fields, routes, published status, duplicate identities, paired draft/published equivalence, source fingerprints, verified renderer results, absence of existing structured fields and availability of migrated document records. It never interprets one hash or path alone as proof that a sidecar belongs to a draft: this rehearsal additionally requires identical raw content and route in the draft/published pair. That equivalence is evidence for preserving the current published site's body in the matching draft, not confirmation that the body's claims are up to date. In a five-seminar case existing separate fields are preserved byte-for-byte; the agreed page order changes from mode→plan to plan→mode when both are filled.

Example from `web/` (set `AUDIT` to an existing **private** directory; filenames and source need to be prepared independently):

```sh
AUDIT=/private/path/to/audit
node_modules/.bin/tsx scripts/seminar-migration/render-audit.ts "$AUDIT/converter-input-real-20261113.json" ../fixtures/content-snapshot/collapsible_panels.json "$AUDIT/render-audit-v5-20261114.json"
IKPK_MIGRATION_AUDIT_DIR="$AUDIT" IKPK_MIGRATION_RUN=review-001 node_modules/.bin/vitest run --config vitest.migration.config.ts
python3 scripts/seminar-migration/rehearse.py "$AUDIT/documents-rehearsal.db" "$AUDIT/converter-input-real-20261113.json" "$AUDIT/render-audit-v5-20261114.json" "$AUDIT/actual-render-review-review-001.json" "$AUDIT/actual-render-existing-fields-review-001.json" "$AUDIT/new-copy.db" "$AUDIT/new-receipt.json" --documents-receipt "$AUDIT/documents-receipt.json" --expected-documents-receipt-digest "$APPROVED_DOCUMENT_RECEIPT_DIGEST" --expected-documents-plan-digest "$APPROVED_DOCUMENT_PLAN_DIGEST" --expected-renderer-sha256 "$APPROVED_RENDERER_SHA256"
python3 -m unittest discover -s scripts/seminar-migration -p 'test_*.py' -v
node_modules/.bin/tsx --test scripts/seminar-migration/render-audit.test.ts
```

The `rehearse.py` invocation additionally requires `--expected-renderer-sha256`, and,
when the input includes document panels, `--documents-receipt`,
`--expected-documents-receipt-digest` and `--expected-documents-plan-digest`. These
digests must be taken from the separately reviewed rendering and document migration,
not from the receipt being checked. Render evidence includes the exact report entry,
document proposal and a fingerprint of renderer sources and dependency lockfile.
The rehearsal refuses if either physical document graph differs from its approved
ledger postimage.

`--plan-output <new-private-file>` exports the verified payload only when no
content exceptions remain. Seal that payload using `sealContentPlan` from
`cms/scripts/content-migration-writer.mjs`, review both the sealed plan digest
and its file SHA independently, and provide both to `reviewed-content.mjs`.
Sealing or matching a file hash is not itself approval of the data or a deploy.

The input database must be a schema-ready isolated copy on which document records have already been migrated and separately audited. Neither new output may exist; the source is opened read-only and the target is created exclusively. The receipt contains preimages and postimages, but no automatic production rollback is provided. The tool does not prove that another process has not altered a SQLite WAL between hashing and backup; run only on an offline quiescent source. Before any deployment, integrate atomic migration and independently audit its complete composed result, permission changes, backup, rollback, and publication workflow. In particular, the documented eight source links to a neighbouring regulation section are preserved unchanged and still require editorial review.
