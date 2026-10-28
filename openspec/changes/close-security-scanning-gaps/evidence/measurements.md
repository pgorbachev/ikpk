# Security measurements — 2026-10-28

Исследована [main security configuration на commit 4be9d1d8fdc683d4611d3bd87706d8e572592a41](https://github.com/pgorbachev/ikpk/blob/4be9d1d8fdc683d4611d3bd87706d8e572592a41/.github/workflows/security.yml).

GitHub REST read-only проверки: CodeQL default setup state=not-configured. Advanced CodeQL workflow отсутствует в исходном дереве. Required checks main не включают runtime payments, CMS audit и полный audit. strict=true, enforce_admins=true.

## Полное lockfile-дерево

Команда `npm audit --include=dev --package-lock-only --json` выполнена отдельно в каждом пакете; код выхода каждого npm процесса 1, JSON с metadata.vulnerabilities получен. Установка и lifecycle scripts не запускались. Это состояние dependency advisory feed, не проверка работающего приложения и не доказательство достижимости эксплуатации. Время записи evidence позднее начала запросов.

| Пакет | low | moderate | high | critical | total |
|---|---:|---:|---:|---:|---:|
| web | 2 | 6 | 16 | 1 | 25 |
| cms | 2 | 17 | 30 | 1 | 50 |
| scripts | 0 | 1 | 3 | 2 | 6 |
| payments | 0 | 0 | 1 | 0 | 1 |

Счётчики — package entries npm, не уникальные CVE. Scripts critical включает tinypool и распространяющий его severity vitest; суммирование не означает независимые уязвимости. Критические entries web proxy-addr, CMS dompurify; payments high brace-expansion. `fixAvailable` требует проверки совместимости и не принимается как доказательство готового безопасного обновления.

[Машинные метаданные и SHA-256 lockfiles/отчётов](measurements.json), [исходные JSON всех npm-отчётов](audit-reports.zip).

## Отдельный CI runtime-снимок CMS

[Security run 40693251362](https://github.com/pgorbachev/ikpk/actions/runs/40693251362), artifact cms-runtime-audit-report ID 12818077210: low=3, moderate=15, high=30, critical=1, total=49. Исходный JSON сохранён в том же архиве. Полный локальный audit и CI runtime audit имеют разный scope и время запроса; их разность нельзя выдавать за точное число dev-only advisory.

## Ограничения

CodeQL не запускался; GitHub settings не менялись. Исправления зависимостей, политика исключений, negative merge probes и live DAST ещё не выполнялись. Эти измерения не являются принятием известных рисков и не разрешают автоматически формировать allowlist.
