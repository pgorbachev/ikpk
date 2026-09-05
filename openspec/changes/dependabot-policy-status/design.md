## Context

База: origin/main@7afc15c01485524c9eb9dd4bb3dcd5b95f387473. Наблюдение 2026-09-05: [PR #216](https://github.com/pgorbachev/ikpk/pull/216), [assessment run](https://github.com/pgorbachev/ikpk/actions/runs/33912679538/job/101152602094): анализ успешен, metadata отсутствуют, класс требует ручного ревью, gate отрицателен. Использованный immutable engine — 12814d0eed47f2a2b02587cb4e4dfa5b923c0d67. Текущая branch protection не требует eligibility или provenance; rulesets для main отсутствуют.

## Goals / Non-Goals

Цель — достоверные статусы при сохранении положительного разрешения автоматике. Не меняем классы разрешённых зависимостей, проверку подписи, trusted producer, права workflow или branch protection. Человеческий native auto-merge принадлежит владельцу, Dependabot policy его не обслуживает.

## Decisions

1. В assessment ввести явный результат: not-applicable, manual-review, eligible, error, отдельно от origin-positive и enable permission. Подтверждать автора по свежему PR API после аутентификации source; проверять совпадение head до раннего выхода. Фильтр по actor неверен: человек может изменить ветку Dependabot.
2. На подтверждённом человеческом PR завершать оценку до metadata, signature и registry. Публиковать skipped eligibility и skipped provenance на opened/synchronize; повторные marker/reopened события не перезаписывают provenance. Не снимать человеческий marker.
3. У PR Dependabot различать успешно распознанный ручной класс и ошибку получения данных. Origin оценивается независимо: manual+valid даёт neutral/success, manual+invalid даёт failure/failure. Нельзя делать любой eligible=false нейтральным.
4. Разделить успех выполнения job и разрешение. Jobs штатных исходов успешны либо пропущены, publisher явно пишет требуемый conclusion. Enable job проверяет явное положительное разрешение; consumer evidence продолжает требовать success check и успешный exact trusted job, SHA/PR/run/attempt identity. Успех job сам по себе не является provenance.
5. Снятие недопустимого marker остаётся дополнительной мерой для Dependabot PR. Принятый владельцем риск ручного native auto-merge остаётся: скрипт не заменяет required check. В дельте исправлены противоречащие этому старые обещания остановки merge.
6. Приёмка CI проверяет status matrix, workflow conclusion и разрешение на действие вместе. Требуются сценарии человеческого PR, разрешённого bot PR, ручного класса, отсутствующих metadata, человеческого коммита в bot PR, stale head и поддельного evidence. Проверка YAML должна отслеживать фактически подключённый immutable engine.

## Risks / Trade-offs

- Neutral/skipped могут выглядеть как проход CI → enable принимает только явное положительное решение, регресс-тест инвертирует это условие.
- Подмена skipped provenance положительным свидетельством → consumer проверяет conclusion, producer identity и exact job; негативный тест обязателен.
- Старые красные результаты останутся на существующих головах → после rollout переоценить открытые человеческие PR доверенным producer; не перекрашивать исторические результаты вручную. Способ переоценки должен соблюдать opened/synchronize-only provenance; для проверки нового SHA достаточно обычного следующего обновления PR.
- Изменение engine без обновления pin ничего не изменит → rollout выделяет отдельный шаг обновления dispatcher pin на проверенный доступный immutable SHA.

## Migration Plan

Спека и независимое ревью → утверждение владельца → отдельная сессия красных тестов → реализация другим исполнителем → независимое ревью полного SHA → merge engine и обновление pin → проверка живых PR. При откате вернуть прежний pin: красный шум вернётся, разрешение не расширится. Перед реализацией перечитать журнал change-flow и проверить лимит active; сейчас это proposal, не active реализация.

### Переход между engine

Consumer привязывает provenance к TRUSTED_POLICY_SHA. Новый pin намеренно не принимает старое evidence. После переключения открытые Dependabot PR могут получить failure на marker/reopened и остаются без нового разрешения до настоящего Dependabot synchronize с новым SHA и действительной подписью, создающего evidence нового engine. Reopened и повтор старого source не заменяют введения новой вершины. Updater также требует положительного родителя нового engine; до этого используется пересборка самим Dependabot. Проверка rollout охватывает отказ старому evidence, новый bot head с положительным evidence, marker-event на новом SHA и аналогичный переход после rollback. Старые bot PR и их marker фиксируются в отчёте; снятие marker остаётся дополнительной мерой с принятой гонкой native auto-merge. Комментарии-команды боту требуют отдельного явного разрешения владельца на отправку сообщений.
