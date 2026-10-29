## Context

Мотивация и измеренный исходный SHA приведены в proposal.md. Аудит CMS уже валидирует числовую структуру отчёта и не глотает ошибки измерения; этот механизм нужно сохранить. Защита main — classic branch protection со strict и enforce_admins. CodeQL default setup по API не настроен. Гейт публикации и merge различаются, данный change усиливает merge.

## Goals / Non-Goals

**Goals:** стандартные GitHub инструменты для security-анализа, полный npm audit и минимальная проверяемая политика принятого риска.

**Non-Goals:** собственный SAST, дублирование CodeQL через Semgrep, автоматическое признание CMS advisory безопасными, изменение инфраструктуры или запуск сканера против production. Наличие advisory не доказывает достижимость эксплуатации; отсутствие advisory не доказывает безопасность.

## Decisions

### Стандартный CodeQL через минимальный advanced workflow

Официальный CodeQL Action, security-extended query suite, языки javascript-typescript, python, actions; отдельный job/category на язык. На стадии реализации проверить доступность языков и закрепить актуальные Actions полными SHA. PR в main, push main, еженедельный schedule; без path filters, чтобы обязательный статус не исчезал при docs-only PR. Анализировать исходники без запуска приложения/сборки с секретами. Не включать параллельно Default setup: два режима не должны конфликтовать.

Default setup проще и был первым вариантом. Однако GitHub документирует исключение CodeQL merge-protection для Dependabot PR, анализируемых default setup. Минимальный advanced workflow выбран ради одинаковой доказуемой защиты человеческих и автоматически сливаемых PR. Semgrep не добавляется: сначала используется встроенный инструмент. JS/TS-анализ не считается полным покрытием .astro; существующие rich-content source/output gates остаются.

### Отдельные полные audit без удаления существующих статусов

Сохранить имена и область существующих runtime jobs. Добавить матрицу полного audit web/cms/scripts/payments, используя npm audit с включением devDependencies и JSON. На первом шаге проверять, что дерево действительно установлено по lockfile и dev-зависимости не исключены окружением; install/audit имеют явные timeout. Для payments проверить также devDependencies: tsx участвует в команде запуска, несмотря на положение в манифесте.

Минимальный policy evaluator на базе существующего тестового инструментария проверяет полную структуру отчёта и исключения; он не подменяет npm advisory feed собственной базой. Аудит исходного дерева и решение по policy сохранять отдельно. Отчёты всех пакетов выкладывать always, absence/broken JSON/network/npm errors fail closed. Устанавливать зависимости без привилегированных секретов; audit не должен зависеть от успешной генерации сайта или доступности CMS.

Переход CMS: синхронно обновить взаимозависимые Strapi packages совместимой проверенной версией, удалить/обновить только несовместимые overrides по фактическому дереву, прогнать lint/typecheck/tests/build и CMS-to-site e2e. npm fixAvailable — подсказка для проверки, не доказательство совместимости; npm audit fix --force не использовать. Если остаётся high/critical, подготовить индивидуальную запись для утверждения владельцем. Без утверждения не добавлять исключение; задача остаётся незавершённой.

Старый runtime CMS report-only переключить на ту же high/critical policy с согласованным локальным script. Полные проверки становятся required. Старое имя CMS job можно заменить только одновременно с проверкой потребителей статусов; действующие required имена не удалять.

### Только ограниченные исключения

Версионируемый небольшой файл с записями по advisory, компоненту, lockfile node, версии, severity, основанию, мерам, владельцу и expiresOn. UTC дата означает истечение с 00:00 этой даты. Без wildcard и генерации разрешений из отчёта. Проверять reference на реально одобренное решение в evidence; указание имени владельца в JSON само по себе не доказательство одобрения. Нераспознанные/противоречивые данные — ошибка. Moderate/low сохраняются в JSON и summary. Расхождение агрегированных severity/total с составом отчёта не превращается в нули.

### Защита merge: fail-closed итог, существующие checks и CodeQL findings

Разместить новые audit и CodeQL jobs в существующем Security workflow. Добавить обязательный итоговый job Security policy с always(): он явно зависит от каждого audit, secret scan и каждого языка CodeQL и принимает только result == success для всех ожидаемых producers. При matrix использовать отдельный итог по всем её ветвям и contract-проверку полноты пакетов/языков; потеря ветви не должна превращаться в зелёный итог. Запретить continue-on-error у security producers и итога; не ставить job-level условие на итог, кроме always(). Полностью отменённый workflow не даёт успешного Security policy. Проверить отрицательные skipped/neutral/cancelled/failed/missing/pending outcomes, включая синтетические данные итоговой проверки; live skipped probe обязателен. Это нужно потому, что required checks GitHub сами по себе принимают skipped/neutral.

Снять snapshot текущей branch protection и rulesets. Добавить required Security policy и contexts каждого полного audit, runtime payments и технических CodeQL jobs; использовать реальные имена после первого прогона, не угадывать. Настроить отдельное active code_scanning правило для main с CodeQL: security high-or-higher, alerts errors, без bypass. Сохранить classic protection и её strict/enforce_admins; правило code_scanning дополняет, а не заменяет её. Технический CodeQL job доказывает выполнение, code_scanning rule — отсутствие новых findings выше порога. Не менять allowlist авто-merge или deny security-boundary overrides.

Проверить effective enforcement на человеческом и Dependabot PR: current head, анализ языков, отрицательный security finding, отсутствующий/красный/пропущенный status и итог Security policy. Если платформа не даёт одинаковой защиты, не объявлять rollout законченным и не ослаблять политику ради зелёного результата. Merge queue не используется в этой поставке; перед приёмкой подтвердить отсутствие включённой очереди или дополнить утверждённый дизайн её событиями.

## Risks / Trade-offs

- Текущий CMS отчёт красный по предлагаемой policy → remediation и явные решения по остаточному риску предшествуют включению required contexts.
- Появление advisory после релиза → weekly audit показывает изменение; работающий сервер автоматически не обновляется.
- Анализатор не покрывает все шаблоны/классы атак → сохранить существующие тесты, записать ограничения и отдельный backlog live DAST/ОС.
- Зелёный job анализа при high findings → отдельное code_scanning правило и negative PR evidence.
- Прежние alerts вне diff → отдельная первичная triage, PR merge-protection не выдаётся за проверку всего дерева.
- Сбой нового гейта может остановить все merge → сначала green producer и negative probes, затем изменение required checks с сохранением snapshot.

## Migration Plan

1. После утверждения спеки отдельный исполнитель пишет RED fixtures/contract tests; предъявить красный прогон на текущей реализации.
2. Реализовать producers и remediation в отдельном worktree, собрать локальные проверки, полные audit и независимые review.
3. Первый реальный PR-прогон и полный scan main, triage всех high/critical; утвердить только перечисленные исключения, если они потребуются.
4. Сохранить GitHub настройки, включить обязательность новых producers и CodeQL policy. Выполнить контролируемые negative probes без merge и публикации уязвимых fixtures. PR comments/reviews не публиковать без явного разрешения пользователя.
5. Отчёт с точными SHA, runs, evidence effective branch protection, покрытием и принятым долгом; архивировать после выполнения tasks.

Rollback ошибочного rollout восстанавливает только добавленные этой поставкой настройки из snapshot, сохраняя исходную защиту. Откат не считается завершением security-задачи и не используется для разрешения merge известной уязвимости.

Источники решений: [GitHub CodeQL setup types](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types), [GitHub merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection), [настройка порогов](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/set-merge-protection).
