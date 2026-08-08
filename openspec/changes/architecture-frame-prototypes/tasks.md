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
- [ ] 3.5 Owner approval of retrospective OpenSpec change `architecture-frame-prototypes`
- [x] 3.6 Negative verification of teacher and date gates (see below)

### 3.6 Негативные мутации (SHA `fd5173fd1ea446fe009048ad89a1f62c908befd3`)

Отдельный worktree на закоммиченном SHA; после каждой мутации — восстановление
`git checkout --`; итог: `git status --porcelain` пуст относительно опорного SHA;
worktree удалён.

**Мутация A — чужой преподаватель**

```bash
# в web/src/lib/home.ts тело findTeacherForSeminar заменено на:
#   if (!refs?.length) return undefined;
#   return teachers.find((t) => t.photo);
npx vitest run tests/home-teachers.test.ts
# RED: findTeacherForSeminar > берёт преподавателя из seminar.teachers…
#      expected 'Пилявский Сергей Орестович' to match /Шадрин/

npm run build:demo && npx vitest run --config vitest.build.config.ts \
  tests/seo-package.test.ts -t 'undated не приписывает'
# RED: undated не приписывает чужого преподавателя института
```

**Мутация B — нет даты в Faculty**

```bash
# снят <li>{next!.dateLabel}</li> из faculty-ветки SeminarArchitectureHeader.astro
npm run build:demo && npx vitest run --config vitest.build.config.ts \
  tests/seo-package.test.ts -t 'faculty с датой'
# RED: faculty с датой показывает дату в шапке (и только он)
```

Восстановление после обеих: тесты зелёные; diff к `fd5173f` по отслеживаемым
файлам пуст.

## 4. Explicitly deferred (not tasks of this change)

- [ ] 4.1 Modular curriculum accordion (§7.6) — later change
- [ ] 4.2 Full-schedule stress + filters + month groups + cycle badge (§7.7) — later
- [ ] 4.3 CI job `build:demo` — closes TD-14
