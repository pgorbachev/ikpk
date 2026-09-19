# Serving/readiness SSH probes: implementation evidence

Independent RED: `1069f456e023f32a9d6485aac7e3995b536279a6`, cherry-picked onto
the assigned implementation base as `feb45e80`. The original 15 assertions were
re-run before implementation: 1 passing harness control, 14 failures.

Implemented the two fixed, separately authorized probes in the existing locked
SSH session. Nginx runs without a shell as `/usr/bin/sudo -n /usr/sbin/nginx -T`.
An anonymous output file and child `RLIMIT_FSIZE` bound output storage; the
10-second subprocess timeout and final 2 MiB check refuse errors/oversize output.
The fixed redirect fragment is opened through a non-symlink directory descriptor,
must be regular, and has a bounded 1 MiB read. Readiness disables environment
proxies and redirects, uses fixed loopback GET with a 10-second socket timeout,
and parses at most 64 KiB. HTTP status and content type remain observations.

`connect`, `inspect-serving`, and `payment-readiness` accept commit/destination
proof before a snapshot exists. Upload, activation, rollback, retained downloads,
and recovery retain their complete proof checks. The probe-only connection still
owns the existing lock file; it creates no release directory.

An additional regression test first failed with `true !== false` at the assertion
that a source-only inspection must not create `releases/`. Directory creation
now belongs to authorized staging. The same test confirms subsequent full-proof
staging creates the directory and transfers the actual bytes.

Validation:

```sh
node --test scripts/tests/publication-serving-probes.test.mjs scripts/tests/publication-transport*.test.mjs
node --check scripts/publication-transport.mjs
git diff --check
```

Result: **84 tests passed, zero failures** (16 serving/readiness, 68 existing
transport tests), including existing authorization, retained transfer, locking,
activation and recovery tests. Both edited Python files also passed `compile()`.
The fake subprocess boundary now honors an explicitly supplied stdout file,
matching `subprocess.run`; no original assertions were weakened.

The actual child file-size limit was checked independently of the fake boundary:
extract `limit_nginx_output` with Python AST, run a Python child writing 2 MiB + 2
bytes to a `TemporaryFile` with that function as `preexec_fn`, and assert a
nonzero exit and no more than 2 MiB + 1 stored bytes. Observed: exit 120,
2,097,153 stored bytes. This extra byte permits an explicit oversized refusal.

No production host or GitHub write occurred. Worker/adapter wiring, whitelist
audit summaries, serving drift parsing, redirect delivery/rollback, nginx reload,
privilege provisioning and live host acceptance remain outside this delivery.
