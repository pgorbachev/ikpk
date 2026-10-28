# GitHub Security workflow evidence — PR #396

Workflow run: [Security #1864](https://github.com/pgorbachev/ikpk/actions/runs/40710673141)  
Tested merge revision: `f985b06d7f14b6dddd0223b4a20e14ad009e2f34`  

## Results

| Producer/check | Result |
|---|---|
| Secret scan | success |
| CodeQL JavaScript/TypeScript | success |
| CodeQL Python | success |
| CodeQL GitHub Actions | success |
| Existing runtime audits: web, scripts, payments | success |
| CMS runtime audit | failure: high/critical findings |
| Full dependency audit: payments | success after the compatible brace-expansion update |
| Full dependency audit: web, CMS, scripts | failure: high/critical findings |
| Security policy contract tests | success |
| Aggregate Security policy | failure, correctly reflecting unsuccessful audit producers |

The audit failures are measured findings, not install or report-validation errors. The report validator accepted a real clean npm v2 report for payments and correctly reconciled its summary with its detail map and dependency inventory. The scripts full report on the preceding implementation run recorded 3 high and 2 critical vulnerable package entries; these counts are not unique CVEs.

## Reports

All artifacts below belong to run `40710673141` and are tied to the tested revision above. GitHub retains them until 2027-01-26.

| Artifact | ID |
|---|---:|
| `full-dependency-audit-web` | `12826970038` |
| `full-dependency-audit-cms` | `12825267900` |
| `full-dependency-audit-scripts` | `12826426357` |
| `full-dependency-audit-payments` | `12826740599` |
| `cms-runtime-audit-report` | `12826765793` |
| `gitleaks-results.sarif` | `12826635862` |

Lint and Typecheck passed in [run 40710673143](https://github.com/pgorbachev/ikpk/actions/runs/40710673143). No local audit, scanner, or tests were run. This evidence does not establish effective required-check/code-scanning enforcement, a clean main-branch baseline, or live application/infrastructure security.
