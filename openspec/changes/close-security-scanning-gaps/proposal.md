## Why

Проверки находят известные уязвимости runtime-зависимостей, но не покрывают весь инструментальный стек; CMS имеет общее исключение, CodeQL не настроен, а аудит payments не обязателен для merge. Нужен проверяемый security-контур с явными ограничениями, а не зелёный CI при непроверенном предмете.

Исследована [security-конфигурация main на SHA 4be9d1d8fdc683d4611d3bd87706d8e572592a41](https://github.com/pgorbachev/ikpk/blob/4be9d1d8fdc683d4611d3bd87706d8e572592a41/.github/workflows/security.yml). GitHub API 28.10.2026 вернул CodeQL `not-configured`; branch protection не требует audit payments/CMS. [Успешный Security run текущего main](https://github.com/pgorbachev/ikpk/actions/runs/40693251362) содержит CMS runtime-отчёт: info=0, low=3, moderate=15, high=30, critical=1, total=49. Это затронутые npm package entries, не число уникальных CVE и не доказательство эксплуатации.

Полный lockfile-аудит от 28.10.2026 дополнительно нашёл high/critical во всех компонентах; scope, точные счётчики и исходные отчёты сохранены в [измерениях](evidence/measurements.md).

## What Changes

- Добавить стандартный GitHub CodeQL для JavaScript/TypeScript, Python и GitHub Actions: PR, push в main и еженедельный прогон. Отчёт отделяет найденную уязвимость от ошибки анализа; покрытие Astro-шаблонов не заявляется.
- Сохранить существующие runtime-аудиты и добавить полный dependency-аудит каждого из web, cms, scripts, payments, включая devDependencies.
- Заменить общее CMS report-only блокирующей политикой high/critical: сначала исправления совместимых зависимостей, затем только индивидуально утверждённые ограниченные исключения. Числа текущего отчёта не становятся автоматически разрешённым baseline.
- Сделать новые dependency-проверки, runtime-аудит payments и результаты CodeQL обязательными для merge, сохранив существующую защиту и ручной путь security-boundary зависимостей.
- Проверить реальное блокирование на контролируемом PR и оформить остаточные ограничения. Изменение не подменяет проверку работающего сервера и не объявляет пентест выполненным.

## Capabilities

### New Capabilities

- `security-scanning`: статический security-анализ, аудит полного dependency-дерева, политика точечных исключений и подтверждённая защита merge.

### Modified Capabilities

Нет. Новая capability дополняет dependency-update-automation; если при реализации понадобится изменить существующее нормативное требование, delta и повторное утверждение должны предшествовать такой правке.

## Impact

Затрагиваются security workflow, package scripts и lockfiles затронутых пакетов, тесты security-политики, документация исключения CMS, настройки code scanning и защиты main. Workflow и настройки GitHub должны пройти независимое ревью перед включением блокировки.

Не входит в эту поставку: production-деплой, обновление установленной CMS/БД, активный пентест, изменение firewall/SSH/TLS, установка Semgrep параллельно CodeQL. Для live DAST и ОС/инфраструктуры остаётся отдельная работа с целями и доступами; пересекающиеся решения server-hardening сохраняются. Гейт новой публикации остаётся отдельным от защиты merge и этим change не изменяется.

## Approval

Утверждён владельцем для реализации через GitHub Checks; выполнение тестов, audits и scans происходит только в GitHub Actions. Будущие исключения не утверждены.
