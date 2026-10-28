# CMS Strapi upgrade compatibility — PR #396

Tested PR head: `fdab6c92211a8e607f60971ae0385c9576329328`  
CI: [Lint and Typecheck run 40716934255](https://github.com/pgorbachev/ikpk/actions/runs/40716934255) and [Security run 40716934477](https://github.com/pgorbachev/ikpk/actions/runs/40716934477)

The CMS job installed Strapi 5.60.0 successfully and passed ESLint and TypeScript checks. Its integration tests failed while loading the published `@strapi/core` fetch module: that release requires an internal `undici` file not present in the pinned undici 6.29.1 package. The resulting `MODULE_NOT_FOUND` canceled 50 dependent CMS integration cases. The repository's pre-change Strapi 5.51.2 graph uses Undici's public `require('undici')` entry.

The 5.60.0 change also invalidated the repository's exact version and source-hash pin for Strapi's admin login module. Updating that pin requires reviewing and preserving the login redirect guard. The candidate transform remained fail-closed, but the unsupported package graph failed the CMS suite before it could be accepted.

The PR restores the Strapi 5.51.2 package and login-guard contract, keeps the existing Undici 6.28.1 lock baseline, and applies independent same-major leaf updates for DOMPurify 3.4.17 and markdown-it 14.3.3. DOMPurify 3.4.17 is the upstream patched version for GHSA-cg2g-xh64-v4q7; the full audit remains responsible for exposing all other unresolved findings. This record does not claim that the CMS audit is clean.

No local tests, scanners, or audits were run. The compatibility finding came from GitHub Actions and read-only inspection of the published package artifacts.
