# New-publication runner: RED contract and production wiring

Base: `a61cd7d639c605b687550f794478334640d14c54` from the root implementation.
Independent authoring branch: `codex/manual-publication-runner-red`, fresh isolated
worktree. Scope is **new publication only**, not rollback, recovery, installation,
transport implementation, or another local-check runner.

## API

`runNewPublication(input, ports): Promise<PublishedOperation>`.

Input extends the existing `PublicationCheckInput` with `publicationId`,
`releaseId`, `actor`, and destination `origin`. These values are assembled by the
trusted installed worker from validated installation configuration and the
launcher's fresh canonical main checkout. They are not an operator-supplied
report or callbacks. `ports` is required for this library helper; the executable
worker binds fixed real modules. No CLI for injecting a report, callback, check
subset, transport command, or alternate CI policy is part of this contract.

`PublishedOperation` contains every `PublicationRecord` field plus the final
accepted `observedEntry`, `highWaterMark`, and `headAtLastCheck`. The record is a
detached immutable copy of the validated evidence, not references to mutable
producer objects. Its identity and evidence are the same in transport pending
state, successful index append, and returned result.

Ports: `readCiEvidence(commit)`, `runChecks(input) -> {report,snapshot}`,
`readMain()`, `state.read(fingerprint)`, `state.appendPublication(record)`,
`digest(treeDir)`, `createTransport({authorize})`, `fetch`, and `now`.
`authorize` is constructed inside the runner after full validation and closes
over the chosen pair and evidence. It checks action/destination, stage digest,
and operation identity. It is not taken from input. New-publication code must
not authorize rollback or recovery through this closure.

## Required effect order

1. Read and validate real CI evidence for the supplied fresh main SHA before any
   capture/check/build or transport creation. Validate policy, exact SHA, event,
   success, all required jobs, and positive executed count independently of the
   effect returning an object. Failure cannot fall back to caller evidence.
2. Run the existing capture/check coordinator once. Its production wrapper reads
   the resulting captured `snapshot.json`; neither input nor a report path lets
   the operator manufacture snapshot/report evidence.
3. Validate the actual content fingerprint and derived snapshot ID, live origin,
   observed entry/revision/HWM, and matching latest journal fingerprint. Unknown,
   stale, regressed, incomplete, or unaccepted state refuses. `observe()` alone
   is insufficient when the latest ledger fingerprint differs from the content.
4. Recompute the actual artifact digest and validate the complete five-group
   report against commit/snapshot/destination/digest. Call the existing pure
   `chooseManualPublication` with full CI/local evidence and accepted state.
   Construct the transport only after this succeeds.
5. Acquire the transport host lock. Stage that exact tree, then activate with
   `beforeActivate` and `recordIndex`. The transport verifies uploaded bytes and
   writes durable pending state before invoking `beforeActivate`.
6. Inside `beforeActivate`, after upload/preparation, re-read canonical main and
   latest CMS entry/revision/HWM. Require equality with the accepted captured
   state and fingerprint. No capture, build, group check, digest, or transfer
   follows this successful final check before atomic activation.
7. In the post-switch `recordIndex` callback, first GET `/release.json`, require
   final HTTP 200 and exact commit/snapshot pair, then GET the destination site
   and require final HTTP 200. Redirects may upgrade HTTP to HTTPS on the same
   hostname; foreign hosts are rejected before following. Network errors,
   malformed declarations, non-200 responses, and wrong pairs refuse.
8. Only after both serving checks append the full immutable record through the
   shared state store. A failure throws while the active operation remains in
   transport pending state. The error identifies the active operation; it never
   pretends that the previous release is still active. The host lock remains
   held through checks and append, and transport clears pending only after ACK.

A new main commit or CMS event **before** the last check prevents the switch. An
event **after** the successful last check is the explicitly accepted residual
window: the checked release finishes switching and the record preserves the
observed entry/HWM/main. Do not re-read sources after switching to retroactively
invalidate this operation. The next content requires another explicit request.

Pre-switch refusal writes no publication record. A switch failure cannot record
an intended release as successful. Transport owns cancellation of a prepared
operation and preservation of post-switch pending state; the runner does not
implement a second pending/recovery protocol.

## Concrete production binding

- `readCiEvidence`: bind `web/scripts/lib/publication-ci.ts` to the fixed GitHub
  repository/workflow policy and credential provider. The worker passes only the
  launcher-confirmed SHA; no report JSON supplied by the operator.
- `runChecks`: bind `runPublicationChecks` to `createPublicationCheckPorts` from
  the separate production adapter delivery. It captures exactly once, builds
  once, writes release.json before checking the artifact, and produces the fixed
  local report. Read the captured snapshot from that adapter's fixed directory;
  do not recapture or modify it after checks.
- `state`: instantiate `createPublicationStateStore` once with canonical shared
  state remote and an isolated work directory. `read` refreshes actual shared
  state; `appendPublication` preserves its existing immutable/CAS retry semantics.
  New-publication runner does not create CMS events or implicitly accept restores.
- `digest`: reuse the shared publication-launcher tree digest and regular-file
  enumeration, not a second format or count from the report.
- `createTransport`: bind the existing `createSshTransport` to the protected
  destination host/user/root/known-host configuration and the runner-created
  authorization closure. This needs the separate transport authorization change;
  no transfer mechanism is implemented here.
- `readMain`: fresh read of the canonical repository's `refs/heads/main` under
  the same trusted source policy as the launcher/CI reader, not local branch HEAD.
- HTTP: fixed GET-only reader with timeout and bounded same-host redirects. Reuse
  declaration parsing if helpful. The older `fetchReleaseDeclaration` helper
  follows redirects and does not expose the final host, so alone it does not
  satisfy this boundary.
- `now`: real clock. Operation IDs/release IDs come from the trusted worker.

The executable worker wiring, default effects, live acceptance, installation,
and operational hardening remain later work. This delivery contains only typed
interfaces, a no-op RED stub, and tests. Existing producer/unit/transport tests
remain responsible for their own mechanics.

## Observed RED evidence

Node v24.13.0, 2026-09-19, own worktree:

```
npx vitest run tests/manual-publication-runner.test.ts tests/manual-publication-runner-fixture.test.ts --reporter=json --outputFile=/tmp/ikpk-runner-red.json
```

**20 tests: 19 RED, 1 GREEN, 0 pending**, expected exit 1. RED assertions took
468 ms; the positive control 64 ms. All 19 failures are missing expected
rejections or behavioral assertions against the no-op stub, not import/harness
failures. Targeted TypeScript, ESLint, and whitespace checks pass with exit 0.

The positive control executes more than twelve recorded effects and actually
copies a local release directory, writes pending JSON, atomically changes a
local symlink, performs two deterministic HTTP-port reads, records the operation,
and removes pending under the simulated lock. It demonstrates that the fixture
can succeed; it is not evidence of real SSH, CI, Astro, browser, CMS, or deployment
acceptance. No network/server mutations or GitHub messages were performed.
