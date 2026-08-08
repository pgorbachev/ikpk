## 1. Demo surfaces and isolation

- [x] 1.1 Registry of architecture variants and section composition
- [x] 1.2 Preview hub + catch-all outside known paths
- [x] 1.3 Home / seminar / seminar-undated / schedule per frame under `DEMO_FORMS`
- [x] 1.4 noindex, sitemap exclusion, provenance legend

## 2. Honest data on prototypes

- [x] 2.1 Live catalog stats; no conflicting hardcoded city/date counts on modular home
- [x] 2.2 Dated seminar teacher from schedule lead only
- [x] 2.3 Undated seminar teacher from `seminar.teachers` (no institute photo fallback)
- [x] 2.4 Faculty dated header shows date label with city/duration/price
- [x] 2.5 Stub labeling for non-functional modular picker

## 3. Verification

- [x] 3.1 Demo build gates for required blocks, undated marker, schedule pages
- [x] 3.2 Unit/build checks for teacher attribution and faculty date
- [x] 3.3 TD-14 recorded for missing CI `build:demo` job
- [ ] 3.4 Owner walkthrough of `/preview/hub` on demo build (acceptance)

## 4. Explicitly deferred (not tasks of this change)

- [ ] 4.1 Modular curriculum accordion (§7.6) — later change
- [ ] 4.2 Full-schedule stress + filters + month groups + cycle badge (§7.7) — later
- [ ] 4.3 CI job `build:demo` — closes TD-14
