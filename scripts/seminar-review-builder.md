# Assemble seminar review candidates

This tool creates candidates, **not approvals**. It does not obtain data, inspect SQLite ledger rows, decide exceptions, run the composition audit, or validate HTML/render preservation. Independently review every step result, schema contract, plan, exception and registry entry against this operation's source and stage snapshots. Do not submit either output until that review and the composition audit are complete. It requires a sealed export that also contains the exact original source database and WAL when present; a SQLite backup with equivalent logical data is not necessarily the same bytes.

Verify and extract the pause archive with the command below. Obtain and independently record the archive SHA-256 outside the archive; the adjacent automatically created sidecar alone is not independent evidence. This checks the exported manifest and member hashes; it does not independently query the remote root journal or approve its contents.

```sh
mkdir -m 700 /private/review/extract-parent
python3 scripts/extract-migration-pause.py --archive /absolute/pause.tar \
  --archive-sha256 <independently-recorded-sha256> --operation-id <id> \
  --source-sha <full-sha> --output-parent /private/review/extract-parent
```

The command creates and reports a new private directory; the default archive and total content limit is 1 GiB, adjustable with `--max-bytes` up to 2 GiB. Retain receipt, candidate, four stage snapshots (the permissions stage is the schema input), source database and its WAL if present. Ensure the candidate has no nonempty WAL. The snapshots and candidate must correspond to the same latest pause; rerun the export and review if anything advances.

Create a private template JSON containing version 1, the independently checked `ledger.lineageId`, full `steps` objects (permissions, schedule, documents, content, each with `id`, `sha256`, `result`), `schemaContract` and `schemaContractDigest`, `schedule` with `plan`, `decisions`, `expectedPlanDigest`, `documents` and `content` with `plan`, `expectedPlanDigest`, `rendererSha256`, and `proofArtifact` with the **remote** reported path and independently admitted SHA-256. Preserve the exact reviewed plan and result JSON; do not fill them from a synthetic example or mark decisions approved automatically. Supply a separately reviewed registry JSON array (empty only when justified by actual candidate). Use a verified copy of the proof archive.

Create config JSON with absolute canonical paths and independently recorded input digests:

```json
{
  "receiptPath": "/private/review/receipt.json",
  "receiptSha256": "<sha256>",
  "templatePath": "/private/review/template.json",
  "templateSha256": "<sha256>",
  "registryPath": "/private/review/registry.json",
  "registrySha256": "<sha256>",
  "proofPath": "/private/review/proof.tar.gz",
  "remoteProofPath": "<exact-proofArtifactPath-reported-by-host>",
  "remoteProofPath": "<exact-proofArtifactPath-reported-by-host>",
  "candidatePath": "/private/review/candidate.db",
  "remoteReceipt": "<exact-receiptPath-reported-by-host>",
  "paths": {"source": "/private/review/source.db", "schema": "/private/review/permissions.db", "schedule": "/private/review/schedule.db", "documents": "/private/review/documents.db", "content": "/private/review/content.db"}
}
```

The exact source `-wal` file, when present, must be adjacent to `source` with that suffix. The local basename may differ from the remote basename; the tool uses the receipt's remote basename when checking `sourceFileFingerprint`. It checks stage `snapshotFingerprint` as SHA-256 over JSON.stringify of `[dbSha256, walSha256-or-null]`; these are different encodings. The config hash must be independently recorded after inspection.

```
mkdir -m 700 /private/review/output
shasum -a 256 /private/review/config.json
node scripts/seminar-review-builder.mjs /private/review/config.json <config-sha256> /private/review/output
```

The output files are private and create-only. The printed hashes distinguish raw file SHA-256 from the composition contract digest (SHA-256 of JS `JSON.stringify` of the parsed object). The registry binding always names the operation's fixed remote content-addressed path, not the local registry path. Review the complete generated files and run the existing composition auditor on the five verified databases. Since its proof path is remote, a local audit needs a separately copied contract with only the proof path replaced with the local exact archive and a newly calculated contract digest; the final submitted contract retains the remote path. Local audit returns `partial` pending binding. The runner repeats it against the exact remote contract before it can accept the binding.

Use the handoff runbook's compositionReview and registryReview manifests to submit separately with independently recorded output file hashes. This tool does not prove source ownership, independently attest the exporter, compare a receipt with the root journal, or ensure transport fits the 16 MiB host limit. Validate exported manifest provenance and hashes separately and measure the full base64-encoded review transport before fencing.
