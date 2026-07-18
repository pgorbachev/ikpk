# Contributing

Краткий workflow для pull request в этом репозитории.

## Перед началом

1. Сверьтесь с `AGENTS.md` и актуальным планом в `docs/plans/`.
2. Работайте в отдельной ветке от `main`.

## Локальные проверки

В затронутых пакетах перед push:

| Пакет | Команды |
|-------|---------|
| `web/` | `npm run lint`, `npm run typecheck`, `npm run build` |
| `cms/` | `npm run lint`, `npm run typecheck`, `npm run build` |
| `scripts/` | `npm run lint`, `npm run typecheck` |

## Pull request

1. Создайте ветку: `git checkout -b <type>/<short-description>`
2. Сделайте коммит с понятным сообщением (например, `docs: ...`, `fix(web): ...`).
3. Push: `git push -u origin HEAD`
4. Откройте PR в GitHub на базу `main`.

CI автоматически запустит lint и typecheck для `web`, `cms` и `scripts`.
