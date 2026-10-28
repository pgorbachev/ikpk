## 1. Согласование и contract tests

- [x] 1.1 Два независимых read-only review спецификации завершены; findings отражены в `review.md`.
- [x] 1.2 Владелец утвердил пакет и реализацию проверок в GitHub Actions; это не принимает будущие исключения.
- [x] 1.3 Держать audit-format, workflow-matrix и fail-closed policy tests в репозитории; GitHub Checks на `f985b06d7f14b6dddd0223b4a20e14ad009e2f34` прошли.

## 2. Security producers

- [x] 2.1 Получить на PR точные runtime/full audit reports по всем четырём пакетам. Run `40710673141`, artifacts и результаты: `evidence/security-workflow-run.md`. Не запускать локальные audit/scanner.
- [ ] 2.2 После PR результатов исправить совместимые зависимости без `npm audit fix --force`; не удалять платформенные lockfile entries. Запустить затронутые build/test проверки только в GitHub Checks.
- [ ] 2.3 Не добавлять исключения: сейчас ни одно не утверждено. High/critical остаются блокирующими; будущая запись потребует отдельного явного утверждения и ограниченного проверяемого механизма до её использования.
- [x] 2.4 Добавить полный npm audit всех production/dev dependencies для web/cms/scripts/payments с отчётами; сохранить существующие runtime jobs, перевести CMS runtime на high threshold.
- [x] 2.5 Добавить SHA-pinned CodeQL advanced analysis для javascript-typescript/python/actions и always-running Security policy aggregator, который принимает только success всех ожидаемых producers.
- [x] 2.6 Получить в GitHub Checks contract-test evidence, ошибки измерений и найденные advisory отдельно; policy tests passed, audit findings остаются блокирующими. Локальные tests/scanners/audits не выполнялись.

## 3. Ревью и GitHub enforcement

- [ ] 3.1 Один независимый read-only review финального полного SHA; исправить подтверждённые блокеры и зафиксировать ограничения.
- [ ] 3.2 Получить первый PR run и полный main CodeQL scan; triage findings всего main, не только PR delta.
- [ ] 3.3 **Ответственный: владелец (отдельная работа).** Сохранить snapshot, проверить merge queue и добавить required checks/code-scanning ruleset без bypass, сохранив исходную защиту.
- [ ] 3.4 **Ответственный: владелец (отдельная работа после первых runs).** Доказать effective enforcement для человеческого и Dependabot PR, включая missing/skipped/cancelled checks, матричную полноту и high/error findings.

## 4. Приёмка

- [x] 4.1 Зафиксировать runtime/full audit thresholds, check names и ограничения (.astro, live app, authenticated flows, OS/infra); не заявлять DAST или защиту публикации.
- [ ] 4.2 Передать владельцу финальный SHA, CI links и remediation findings; архивировать change только после выполнения оставшихся требований и GitHub enforcement.
