# Required Scripts unit tests negative proof

Before the branch-protection update, the captured nine-context response in
`prerequisites.md` did not contain `Scripts unit tests`.

After the update, draft PR #123 temporarily added one intentionally failing scripts
assertion at exact SHA `203d0b29e7dc7c3c658298491302d7250ac779b4`.

GitHub reported:

```json
{
  "headRefOid": "203d0b29e7dc7c3c658298491302d7250ac779b4",
  "mergeStateStatus": "BLOCKED",
  "scripts": [{
    "name": "Scripts unit tests",
    "status": "COMPLETED",
    "conclusion": "FAILURE"
  }]
}
```

Failing job:
https://github.com/pgorbachev/ikpk/actions/runs/32068792776/job/95507080574

The required-status-checks endpoint simultaneously listed `Scripts unit tests` among
the eleven required contexts. The intentional failure was removed immediately after
capturing this evidence; the restored scripts suite passes 13/13 locally.
