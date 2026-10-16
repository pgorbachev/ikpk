# Visual baseline reconciliation

Base: `6b514096838084af9e83e0d5ebdab09e0af19749` (`review/visual-baseline-proposal-20261016`).

Canonical build used `SNAPSHOT_SOURCE=pinned`, `CONTENT_SNAPSHOT_DIR=/Users/pgorbachev/projects/private/ikpk-visual-baseline-proposal-20261016/fixtures/content-snapshot`, `CHAT_LOADER_SRC=none`, and `PLAYWRIGHT_SKIP_BROWSER_GC=1`. `prepare-snapshot` read the worktree fixture, reported 445 current entries and 0 errors; Astro built 459 pages. The pre-update run against the old PNGs was red: 12/12 failed. Proposal capture regenerated only the 12 `visual-baseline.spec.ts-snapshots` PNGs; a subsequent comparison without update passed 12/12 (30.0s).

| Page | Desktop old → proposal | Mobile old → proposal | Review |
|---|---:|---:|---|
| home | 6026 → 9077 px | 11739 → 15018 px | Accepted current hero text/photo, compact header, expanded home sections and footer. The review placeholder is expected: the widget is lazy and the guard supplies a deterministic third-party response; full-page capture does not scroll it into view. The magenta patch is Playwright's sole `[data-award-row]` mask. |
| oplata | 2184 → 2274 px | 3542 → 3639 px | Accepted contact details, compact header, CTA, and footer updates; page content otherwise matches. |
| schedule | 8909 → 9061 px | 22586 → 22650 px | Accepted month filter and updated event ordering/date display against the snapshot reference date; the next online webinar is now included. |
| seminar | 4199 → 3896 px | 8332 → 7880 px | Accepted schedule sidebar and its mobile placement; article body and schedule use current fixture content. |
| institute | 6302 → 6427 px | 12372 → 12433 px | Accepted current institute cards and authors-of-methods section, with the new header/footer. |
| articles | 2942 → 2914 px | 4797 → 4619 px | Current card summaries and pagination are visible; images, titles and ordering match the pinned snapshot output. Dates were removed by accepted PR #275 (commit `2fb05bb7c25fdf26e5a9f564e77829e533b2673c`, D22/D25), not by this baseline update. |

All 12 old/new pairs were visually inspected under `web/.visual-review/pair-*.png`. No unexplained difference was found. Source/test explain both conspicuous home artifacts; no new product defect is proposed for baseline.

Independent Sol review of proposal `d2328ba1639b43cb3e1fce7dbe83d41a4d2a19df`: GO; all six pages at both viewports inspected, with no unexplained regression. Old/new review pairs are retained in `/Users/pgorbachev/projects/private/ikpk-visual-baseline-proposal-20261016/web/.visual-review/`. The isolated review used port 4446; its temporary Playwright config is not part of the release change. Canonical CI retains the normal configuration.
