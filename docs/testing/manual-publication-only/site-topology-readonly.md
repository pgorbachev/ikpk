# Public serving prerequisite: read-only verification

Recorded 2026-09-19, 15:30:47 UTC. These observations do not constitute a new
publication, a retained rollback target, or production acceptance.

GitHub repository metadata, read with
`gh api repos/pgorbachev/ikpk --jq '{private,has_pages,homepage,default_branch}'`:

```json
{"default_branch":"main","has_pages":false,"homepage":null,"private":false}
```

The Pages endpoint separately returned HTTP 404. The repository's explicit
`has_pages: false` is the evidence that no Pages site is configured; a 404 by
itself would not distinguish absence from insufficient permission.

System IPv4 resolution returned `158.160.147.32` for both `ikpk.su` and
`www.ikpk.su`. Read-only HTTPS HEAD requests returned:

| Requested address | Final address | Status | Content type |
| --- | --- | --- | --- |
| `https://ikpk.su/` | unchanged | 200 | `text/html; charset=utf-8` |
| `https://ikpk.su/release.json` | unchanged | 404 | `text/html; charset=utf-8` |

The production homepage is available independently of GitHub Pages. Removing the
Pages workflow does not itself transfer files to this VPS. The implementation
removes that workflow and leaves the currently served site in place; the
post-merge availability check remains part of operational acceptance.

`193.124.115.99` remains a separate stand destination. A stand publication cannot
establish production acceptance. The missing production release marker cannot be
treated as an indexed, verified rollback target. No SSH command, filesystem
mutation, deployment, or DNS change was performed in this verification.
