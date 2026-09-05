## Why

Штатный отказ в Dependabot auto-merge на человеческом PR создаёт два красных статуса и приучает игнорировать ошибки CI. Владелец согласовал разделение неприменимости, ручного маршрута и ошибки при сохранении явного положительного разрешения на автослияние.

## What Changes

- Человеческие PR получают `skipped` для Eligibility gate и Provenance evidence.
- Проверенное обновление Dependabot для ручного ревью получает `neutral` eligibility; проверка происхождения остаётся независимой.
- Ошибки данных, проверки и нарушения происхождения остаются `failure`.
- Только положительные eligibility и provenance допускают включение Dependabot auto-merge. Нейтральный либо пропущенный статус не является разрешением.
- Приёмка CI включает матрицу статусов и отсутствие красного workflow при штатном ручном маршруте.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `dependency-update-automation`: область применения, семантика статусов и независимость разрешения автослияния от отображения результата.

## Impact

Затронуты `.github/workflows/dependabot-auto-merge-policy.yml`, dispatcher `.github/workflows/dependabot-auto-merge.yml`, policy evaluator `web/scripts/check-dependabot-auto-merge.ts`, `web/scripts/lib/dependabot-auto-merge.ts`, их тесты и процесс приёмки CI. Branch protection и принятый риск ручного включения native auto-merge не меняются. Изменение только планируется; реализация следует после независимого ревью и утверждения артефактов.
