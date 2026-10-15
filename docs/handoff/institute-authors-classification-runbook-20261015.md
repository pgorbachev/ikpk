# Institute author classification correction

This is the bounded owner-approved correction within D.5 of `cms-address-switch-and-migration`. It does not change URLs, schemas, publication policy, or the OpenSpec artifacts. The prior capture and classification-candidate records remain immutable.

## Accepted rule and source evidence

The owner decided that every person affiliated with the Upledger or Barral institute is an author of methods. The rule is based on the institute relationship only; nationality and language are irrelevant. IKPK people remain classified by their existing roles.

The source for this correction is the production backup captured at 2026-10-14 09:45:15 UTC: SQLite `data.db`, SHA-256 `85c675ae0f7a8bb86a09e4b2a78197adfd893af08ac8952955b38c9aaaa2de7a`, with its matching `uploads.tar.gz`, SHA-256 `9d9fe689fa6269e461da2fbb731a4fb60af0dcbda31eb6cab39b8fba10b9b0b3`. The archive contains 2,166 image files; the source database has 536 media records. The production backup has 32 logical people: 21 teachers and 11 method authors. The two target institutes contain 12 people:

| Institute | Legacy ID | Person | Backup trait | Result |
|---|---:|---|---|---|
| Upledger | 63 | Шрайнер Валерий Эдуардович, MD, CST-D | teacher | method-author |
| Upledger | 64 | Радзинская Елена Викторовна | teacher | method-author |
| Upledger | 65 | Diego Maggio | method-author | no change |
| Upledger | 66 | Thomas Rasmussen | method-author | no change |
| Upledger | 67 | George Michael Morgan | method-author | no change |
| Upledger | 68 | Kenneth Koles Richard | method-author | no change |
| Upledger | 74 | Patricia Quirini | method-author | no change |
| Upledger | 77 | Chas Perry | method-author | no change |
| Upledger | 79 | Carol J. McLellan | method-author | no change |
| Barral | 69 | Roberto Bonanzinga | method-author | no change |
| Barral | 70 | Matteo Ghiretti | method-author | no change |
| Barral | 71 | Paolo Ricci | method-author | no change |

The prepared copy changes only the traits of legacy IDs 63 and 64 from `teacher` to `method-author`; after these corrections, the expected strict-capture manifest has 32 people: 19 teachers and 13 method authors. Existing people with legacy IDs 83, 87, and 88 retain their production traits. Fabio Burigana (legacy ID 80) remains a method author. The classification set used on fresh imports includes legacy IDs 63 and 64.

## SQLite operation

The standalone utility is `cms/scripts/institute-method-author-classification.mjs`. It targets a Strapi SQLite database only. It resolves `better-sqlite3` from the `cms/` package, so the command uses the CMS release's installed native binding.

The command below only plans and prints a report:

```sh
node cms/scripts/institute-method-author-classification.mjs --db /absolute/path/to/data.db
```

After an independently authorized operation window, stop the CMS service, make the normal SQLite backup, then run the same command with explicit write intent and the stopped-service acknowledgement:

```sh
node cms/scripts/institute-method-author-classification.mjs --db /absolute/path/to/data.db --apply --cms-stopped
```

Before any write the utility verifies the Strapi table shape, both institute identities by legacy ID, slug, and exact name, and the complete 12-person roster by legacy ID, exact name, and institute. It discovers document IDs from that database; it does not hardcode current CMS numeric IDs or document IDs. It verifies every physical row for each discovered logical document, including drafts and published versions, and aborts on missing, extra, ambiguous, unlinked, or differently classified rows. `BEGIN IMMEDIATE` encloses the preflight, trait-only writes, and readback. Existing authors are no-ops; a second successful run writes zero rows. A failed update rolls back earlier updates in the same transaction. The operator must keep Strapi stopped for the full command; a database lock does not protect Strapi's in-memory cache or lifecycle behavior.

The original prototype capture and its classification-candidate records remain immutable; the old October 10 SQL snapshot is not a source for this operation. Preparation uses a private copy of the production backup, sanitizes credentials, applies only the two accepted trait corrections, and upgrades the local schema with the two approved additive fields. The copy is loaded with the current Strapi runtime (5.51.2), then checked for schema and content conservation before a normal strict capture. No production database is modified. Any later apply requires its own explicit authorization and operation window. A post-apply capture must be a new artifact with its own source metadata and an explicit reference to this accepted correction; it must not replace the prior capture or candidate record.
