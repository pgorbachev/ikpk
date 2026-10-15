# Institute author classification correction

This is the bounded owner-approved correction within D.5 of `cms-address-switch-and-migration`. It does not change URLs, schemas, publication policy, or the OpenSpec artifacts. The prior capture and classification-candidate records remain immutable.

## Accepted rule and source evidence

The owner decided that every person affiliated with the Upledger or Barral institute is an author of methods. The rule is based on the institute relationship only; nationality and language are irrelevant. IKPK people remain classified by their existing roles.

The pinned source is `/private/tmp/ikpk-demo193-prototype-A-20261013/live-snapshot-final/snapshot.json`, SHA-256 `fc19240f8187b9b86ce435d1b634a67e13d9d6c9c0f7f9ec3fd2405790666a08`. It contains 31 logical people: 18 teachers and 13 method authors. Its two target institutes contain 12 people:

| Institute | Legacy ID | Person | Pinned trait | Result |
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

After the two corrections the logical totals are 16 teachers and 15 method authors. The CMS source classification set used on fresh imports now also includes legacy IDs 63 and 64; existing SQL supplements 87 and 88 are outside this roster and remain unchanged. Fabio Burigana (legacy ID 80) remains a method author.

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

The pinned prototype SQLite database was used only for a read-only dry-run rehearsal. No database was changed by this implementation task. A post-apply capture must be a new artifact with its own source metadata and an explicit reference to this accepted correction; it must not replace the pinned snapshot or candidate record.
