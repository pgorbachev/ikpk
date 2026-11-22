## Why

Еженедельная пачка Dependabot от 16 ноября 2026 осталась на ручном ревью целиком, хотя обязательный CI на этих головах был зелёный. Два patch/minor в уже разрешённых `web` и `scripts` удержала книжная правка lockfile: у `node_modules/playwright-core` снялся флаг `peer`, а версия и integrity не менялись. Patch линтера в `cms` не входит в таблицу допуска, хотя его ломает eslint и `tsc` внутри обязательного `cms checks`.

## What Changes

- Зарегистрированный узел security-реестра удерживает PR на ручном пути только при смене идентичности: `version`, `resolved`, `integrity` или карта зависимостей. Снятие `peer` и прочая книжная метаинформация сами по себе узел не меняют.
- Прямое имя пакета из реестра (`parse5`, `playwright` и остальные перечисленные) по-прежнему удерживает PR.
- В `cms` patch/minor закрытого списка получает автослияние: `@eslint/js`, `eslint`, `globals`, `typescript`, `typescript-eslint`, `@types/node`.
- `payments` не входит в таблицу: обязательного `payments checks` в branch protection нет, а обязательный audit этот пакет смотрит без секции разработки.
- `@types/react` и `@types/react-dom` в список не входят: обязательный `tsc` не компилирует `cms/src/admin/`.
- Major, runtime `cms` и смешанная группа остаются ручными.
- Группировка Dependabot и матрица статусов не меняются. Pin dispatcher переезжает на коммит, в котором уже лежит новый классификатор.

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `dependency-update-automation`: таблица допуска для toolchain-списка в `cms`; критерий «узел lockfile изменился» сужен до идентичности пакета; позиция `cms` остаётся отдельным PR, но для имени из списка это уже не запрещённый пакет.

## Impact

Классификатор `web/scripts/lib/dependabot-auto-merge.ts`, сравнение узлов в `web/scripts/check-dependabot-auto-merge.ts` и строка `uses` в `.github/workflows/dependabot-auto-merge.yml`. Конфиг `.github/dependabot.yml` не меняется. Живые PR #493 и #495 станут разрешёнными после нового прогона оценки на голове, где идентичность `playwright-core` не изменилась, и только когда pin указывает на коммит с новым классификатором. #492, #496, #494 и #491 остаются ручными.
