# Live rollout and acceptance

Всё ниже — наблюдения через GitHub API и Actions, а не пересказ. Времена в UTC.

## 1. Состояние после rollout (снято 2026-08-18T15:00Z)

PR #137 «ci: activate Dependabot auto-merge policy» слит **merge-коммитом**, как и
требовалось: промежуточные immutable policy commits обязаны остаться достижимыми.

```
merge commit 052b8b25394743e0f3f9f2feaaa8e6f046fcfc81
  parents 634dad5c75b1f67b16c4fa73f072d14717a3b305 (предыдущий engine PR #135)
          01dc8e3d0c3ad3022058bcc4de7ce2377f233d59 (точная вершина PR #137)
  mergedAt 2026-08-18T14:07:34Z, mergedBy pgorbachev
```

Два родителя и второй родитель, равный ожидаемой вершине PR, — доказательство того, что
это не squash и не rebase. Достижимость обоих policy commits из `main` проверена
`git merge-base --is-ancestor`:

| commit | что это | достижим из `main` |
|---|---|---|
| `8705b85a23a6b71d8977aba3b732c67847921144` | auto-merge policy | да |
| `1de4d5bacb55e8f2e15da3bea9f8bcf972c1b087` | rebase policy | да |
| `01dc8e3d0c3ad3022058bcc4de7ce2377f233d59` | вершина PR #137 | да |

### Ruleset допустимости

`GET /repos/pgorbachev/ikpk/rulesets/20993209`, созданный 2026-08-18T17:06:52+03:00:

```json
{
  "id": 20993209,
  "name": "Dependabot auto-merge eligibility",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [{ "type": "required_status_checks", "parameters": {
    "strict_required_status_checks_policy": true,
    "required_status_checks": [
      { "context": "Dependabot auto-merge / Eligibility gate", "integration_id": 15368 }
    ] }}],
  "bypass_actors": [
    { "actor_id": 1122487, "actor_type": "User", "bypass_mode": "pull_request" }
  ]
}
```

Единственный bypass actor — владелец, режим `pull_request`, то есть обход возможен только
через PR и только для этой одной проверки.

Старый ruleset `14690936` («main protectioin», deletion/non-fast-forward) не изменялся:
он по-прежнему присутствует отдельной записью со своим `enforcement: active`.

### Branch protection

`GET /repos/pgorbachev/ikpk/branches/main/protection`: `strict: true`,
`enforce_admins.enabled: true`, и все 11 прежних required checks сохранены —
`web checks`, `cms checks`, `scripts checks`, `Unit and build tests`,
`Playwright smoke (desktop + mobile)`, `Secret scan`, `Runtime dependency audit (web)`,
`Runtime dependency audit (scripts)`, `Lighthouse budgets (4 templates, median of 5)`,
`Dependency update invariants`, `Scripts unit tests`. Обычные CI checks bypass не получили:
они остаются в branch protection, а bypass есть только у ruleset допустимости.

## 2. Дефект D1: обязательный check не публиковался вовсе

**Наблюдение.** Первые же настоящие события после rollout (три PR, `synchronize`)
прогнали доверенный producer целиком — и упали в одном и том же месте.

| dispatcher run | source signal run | PR | результат |
|---|---|---|---|
| 32151344352 | 32151328732 | 134 | failure |
| 32151376093 | 32151355780 | 132 | failure |
| 32151397565 | 32151364146 | 136 | failure |

Состав jobs у 32151344352: `Authenticate source signal` — success,
`Policy / Authenticate dispatcher caller` — success, `Policy / Fresh pull-request
snapshot` — **failure**, `Policy / Eligibility gate` — failure, `Policy / Assessment`,
`Policy / Enable native auto-merge`, `Policy / Publish head-bound policy checks` —
skipped.

То есть доверенная двухступенчатая аутентификация сработала (это положительная находка:
signal → artifact → dispatcher → caller guard прошли на живом событии), а дальше политика
падала.

**Причина.** `jq -e` завершается кодом 1, когда последнее выведенное значение — `false`.
Шаг читал пометку выражением `.auto_merge != null`, а `auto_merge` у PR без включённого
авто-слияния равен `null`:

```
$ echo '{"auto_merge":null}' | jq -er 'if has("auto_merge") then (.auto_merge != null) else error("missing auto_merge") end'
false
exit=1
$ echo '{"auto_merge":{"enabled_by":{"login":"x"}}}' | jq -er '...той же записью...'
true
exit=0
```

**Следствие, измеренное на живом PR.** Публикация check'ов требует
`needs.snapshot.result == 'success'`, поэтому не публиковалось ничего:

```
$ gh api "repos/pgorbachev/ikpk/commits/3dfbdc0cb3789fd694f3e17092a69139574a8b20/check-runs?filter=all&per_page=100" \
    --jq '[.check_runs[]|select(.name|test("Dependabot auto-merge"))]'
[]
$ gh api repos/pgorbachev/ikpk/pulls/134 --jq '{mergeable,mergeable_state}'
{"mergeable":true,"mergeable_state":"blocked"}
```

Проверка `Dependabot auto-merge / Eligibility gate` уже была required, а отчитаться не
могла никогда — значит блокировались **все** открытые PR, и автоматизация не могла
включить авто-слияние даже правильному PR: job включения пометки живёт в том же прогоне и
тоже пропускался.

Дефект **fail closed** — лишнего слияния не произошло, — но автоматизация была
неработоспособна.

**Кто его исправил.** Параллельно с этой работой тот же дефект нашёл и закрыл другой
исполнитель: PR #138, слитый в `main` merge-коммитом `1f6140f`. Там `jq -er` заменён на
`jq -r` (отказ при отсутствии поля по-прежнему даёт `error`), пин переведён на engine v4
`b8797f132dc5f50600faaf6a16d537fb9be0701e`. Моя собственная правка того же места
(`| tostring`) **отброшена при слиянии** — переделывать уже сделанное незачем, а две
разошедшиеся редакции одного шага хуже одной. В ветке осталась только та часть, которой
не было ни у кого: дефект D2, обновление спеки и характеризующие тесты.

Тесты при этом сохранили силу и стерегут **слитую** редакцию: возврат `-e` в неё
(`s/jq -r 'if has\("auto_merge"\)/jq -er 'if has("auto_merge")/` над
`dependabot-auto-merge-policy.yml`) даёт 30 passed / 3 failed против контроля 33 / 0,
и краснеют «сообщает auto-merge-enabled=false, а не падает», «отличает устаревшую вершину
события от текущей» и — независимо — пришедший из #138 тест о совпадении дерева с
закреплённой ревизией.

Две проверки над одним предметом здесь **не дублируют друг друга, и расхождение названо**:
тест из #138 исполняет политику **по закреплённому SHA**, поэтому поломка рабочего дерева
без смены пина его не красит; мой тест исполняет **рабочее дерево**, поэтому не заметил бы
расхождения пина. Красит такую поломку третий — про совпадение дерева с пином. Ответы всех
трёх на этом дереве согласованы.

**Почему это не поймали 672 теста.** Предмет дефекта — shell внутри workflow. Все прежние
проверки смотрят либо на TypeScript-модуль решения, либо на структуру YAML; ни одна не
исполняла сам шаг. Новый тест исполняет **тот самый текст шага, взятый из YAML**, а не его
копию: разошедшаяся копия и была бы следующим таким же дефектом.

## 3. Дефект D2: продвижение не могло опознать слитый PR

Слияние PR #137 само породило событие `closed`, то есть механизм продвижения был проверен
живьём сразу же — и упал:

```
signal     run 32146430416  .github/workflows/dependabot-rebase.yml  pull_request_target  success
dispatcher run 32146446224  job «Authenticate merged source»         FAILURE (exit 1)
```

**Причина** — измеренное ограничение площадки, а не ошибка в предикате:

```
$ gh api repos/pgorbachev/ikpk/actions/runs/32146430416 --jq '{event,conclusion,pr_count:(.pull_requests|length)}'
{"event":"pull_request_target","conclusion":"success","pr_count":0}

$ gh api repos/pgorbachev/ikpk/actions/runs/32151328732 --jq '{event,pr_count:(.pull_requests|length)}'
{"event":"pull_request_target","pr_count":1}
```

Оба run — одного типа события, но у закрытого PR связь run→PR пуста, а у открытого
заполнена. Dispatcher требовал `pull_requests | length == 1`, то есть требовал
невыполнимого: опознать PR он не мог **никогда**.

Это дефект и **спеки**, а не только кода: требование «Dispatcher SHALL проверить exact
source run, workflow path, event, conclusion, actor, PR/head association …» для закрытого
PR неисполнимо. Спека обновлена через `/opsx:update`: связь требуется там, где площадка её
сохраняет; для закрытого PR она устанавливается типизированным artifact (номер PR) плюс
свежим authoritative снимком (факт слияния и вершина), а artifact доказательством слияния
не служит.

## 4. RED → GREEN

Файл `web/tests/dependabot-auto-merge-live-regressions.test.ts`.

- **RED** на дереве до фикса (родитель `bae6af95`), из каталога `web/`:
  `npx vitest run tests/dependabot-auto-merge-live-regressions.test.ts` → **5 failed /
  13 passed**. Покраснели ровно положительные ветви обоих дефектов: «сообщает
  auto-merge-enabled=false, а не падает», «отличает устаревшую вершину события от
  текущей», «аутентифицирует закрытый PR по типизированному artifact, хотя pull_requests
  пуст», «читает свежий снимок PR из API», «остаётся read-only и выгружает ровно один
  типизированный artifact».
- **GREEN** после фикса: **20 passed / 20**.

Оговорка, без которой числа обманывают: 13 «отвергает …» тестов на дереве до фикса
проходили **вакуумно** — dispatcher тогда отвергал вообще всё. Их осмысленность
доказывается не зелёным цветом, а мутациями ниже.

## 5. Негативная проверка гейтов

Опорный SHA фикса — `bae6af953e3370cd1fc7b7dd31d3fcd269251609`. После каждой мутации
дерево восстанавливалось и сверялось с этим SHA (`git diff --quiet <SHA> -- <файл>`);
расхождений не было. Прогон один и тот же:
`cd web && npx vitest run tests/dependabot-auto-merge-live-regressions.test.ts`.

Контроль без мутации: **20 passed / 0 failed**.

| мутация (perl-выражение над файлом) | числа | покраснел ИМЕННО |
|---|---|---|
| вернуть D1 — на моей тогдашней редакции: `s/\.auto_merge != null \| tostring/.auto_merge != null/` | 18/2 | «сообщает auto-merge-enabled=false…» + «отличает устаревшую вершину…» |
| вернуть D1 — на **слитой** редакции из #138: `s/jq -r 'if has\("auto_merge"\)/jq -er 'if has("auto_merge")/` | 30/3 (контроль 33/0) | те же два теста + «executes the exact policy revision pinned by the dispatcher» |
| снять `test "sha256:$(sha256sum …)" = "$ARTIFACT_DIGEST"` | 19/1 | «отвергает artifact с несовпадающим digest» |
| снять **обе** проверки количества artifact | 19/1 | «отвергает второй одноимённый artifact» |
| снять `test "$(jq -er '.schema' …)"` | 19/1 | «отвергает schema другого сигнала» |
| снять `test "$API_MERGED" = "$SIGNAL_MERGED"` | 19/1 | «отвергает противоречие между artifact и свежим снимком» |
| убрать `.head.sha == $head_sha` из свежего снимка | 19/1 | «отвергает свежий снимок с другой вершиной» |
| убрать `.artifacts[0].workflow_run.id == $run_id` | 19/1 | «отвергает artifact от другого run» |
| `.sourceRunAttempt == $run_attempt` → `(.sourceRunAttempt \| type == "number")` | 19/1 | «отвергает artifact от другой попытки того же run» |
| убрать сверку `.path` источника | 19/1 | «отвергает source run от другого workflow» |
| убрать `.event == "pull_request_target"` | 19/1 | «отвергает source run от другого события» |
| `.conclusion == "success"` → `(.conclusion \| type == "string")` | 19/1 | «отвергает source run с неуспешным исходом» |
| снять `test "$ARCHIVE_MEMBERS" = dependabot-rebase-signal.json` | 19/1 | «отвергает лишний файл в архиве» |

**Две мутации первого прогона остались зелёными, и причины у них разные — их обязательно
различить, иначе вывод о гейте делается по неудавшемуся эксперименту.**

1. Снятие одной строки `test "$(jq -er '.total_count' …)" -eq 1` дало **19/0**: предмет
   остался, потому что единственность artifact стерегут **две** строки, и вторая
   (`.artifacts | length`) поймала фикстуру с двумя artifact. Гейт не декоративен —
   при снятии обеих строк тест краснеет (строка в таблице выше).
2. Снятие `test "$ARCHIVE_MEMBERS" = …` дало **19/0** по настоящей причине: теста на
   лишний файл в архиве не было **вовсе**. Непройденная ветвь — такое же обещание, как
   непроверенный гейт, поэтому тест добавлен (коммит `3ee0d97`), и после этого та же
   мутация краснеет.

Отдельно: первая редакция мутации «снять привязку к `run_attempt`» вырезала кусок
jq-фильтра и **сломала его синтаксис**, из-за чего dispatcher отвергал всё подряд и
покраснели положительные тесты, а не целевой. Результат недействителен, мутация повторена
точечно — заменой предиката на всегда истинный. Красный цвет прогона сам по себе ничего
не доказывает: судить надо по имени покрасневшего теста.
