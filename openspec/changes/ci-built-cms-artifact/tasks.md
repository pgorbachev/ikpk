## 1. Contract and proof

- [x] 1.1 Validate the reconciled deployment deltas for applicability against the current main specs.
- [ ] 1.2 Establish target platform and Node/ABI facts for staging194 and production using read-only evidence; determine whether one artifact and any native dependency payload are compatible with both. Do not assume host equivalence.
- [ ] 1.3 In an isolated CI-equivalent environment build the candidate without live inputs, run existing migration/artifact checks, check native module loading and validate target administration paths with non-secret settings.
- [ ] 1.4 Produce independently reviewed tests for mismatched source, run/attempt, bytes, lockfile and platform, post-fence byte substitution and retry, consistent workspace update/rollback and protected cleanup, as well as unchanged fence, backup, migration and recovery behavior; record the required red results.

## 2. Implementation and verification

- [ ] 2.1 Build and bind the verified CMS artifact to the trusted exact-SHA CI run using existing CI and delivery mechanisms.
- [ ] 2.2 Admit and validate that artifact at the existing prepare boundary without a destination CMS build; refuse invalid or incompatible artifacts before fencing writers.
- [ ] 2.3 Run focused tests and the required CI, and obtain independent reviews of the final revision including a simplification pass.

## 3. Staging acceptance

- [ ] 3.1 After explicit 194 handoff, fence new writes, inspect state and workers, wait for recorded or recognizable legacy workers to finish normally or refuse, then stop the old CMS under the existing transition; retain the documented limitation for already accepted handlers. Rehearse the admitted exact revision, verify preserved writer fencing, backup, migration, workspace/release identity, health, media, explicit recovery and retryable cleanup, and record duration.
- [ ] 3.2 Update the deployment skill for the verified process and archive the approved change only after acceptance. Do not deploy production without a separate explicit request.
