# Payment transport regression — 2026-10-21

Проверка выполнена в отдельном worktree `verify/chat-entry-payment-20261021` на точном candidate `9fcef2db3014ed267ebdf75898f22b26cc71f276`. Кандидат основан на зафиксированном свежем `origin/main` `fabaa27f1e2108d82e4a0f3e58864b29d40f5419`. Product source freeze: `da95fdf0a05359d82b5ebe483b53d7f08436bdb6`.

## Команды и результат

Из корня репозитория:

```sh
env -u DEMO_OUTPUT CHAT_LOADER_SRC=https://chat-loader.invalid/probe/loader_probe.js npm --prefix web run build:stand
```

Exit 0. `PAYMENT_ROLE=stand`; построен `web/dist-stand`: Astro собрал 459 страниц, Pagefind проиндексировал 272 страницы / 15 497 слов. Prebuild подготовил 387 базовых и 739 адаптивных media derivatives, скопировал 58 файлов без преобразования; ошибок 0. Media gate проверил 7 snapshot-записей.

Из `web/`:

```sh
npm exec -- playwright test tests/payment-transport.spec.ts --config=playwright.stand.config.ts --project=stand-role --workers=1
```

Exit 0: **26 passed, 0 failed, 0 skipped**, один worker, около 1.2 минуты. Фактическая конфигурация выбрала `stand-role` и артефакт `dist-stand`.

В `dist-stand` подтверждён loader trigger `data-chat-loader-src="https://chat-loader.invalid/probe/loader_probe.js"` в **458 HTML-файлах**. URL — заведомо несуществующий домен `.invalid`; он задавался только как build-time probe.

## Граница платежного транспорта

Конфигурация Playwright сохранила `--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE 127.0.0.1`; локальный preview работал на `127.0.0.1:4324`. В `payment-transport.spec.ts` перед тестовыми моками ставится fail-closed payment guard, а после каждого теста проверяется `expectNoEscapes(guard)`. Все 26 проверок прошли: **0 незамоканных обращений к объявленной payment API, постороннему контуру или живой ЮKassa**. Тесты используют локальные транспортные моки; реальных оплат, запросов к `193.124.115.99`, ЮKassa или секретов в прогоне не было.

Порт 4324 после завершения освободил только подтверждённый процесс `astro preview` этого worktree. Чужой listener на 4325 (PID 99920) оставлен нетронутым.

## Идентичность и целостность

SHA-256 файлов проверки на candidate:

- `web/tests/payment-transport.spec.ts`: `cd9bf272af7f8287e0b08cc595148212212f695b4ebf743e7f2b19cf22ef3251`
- `web/playwright.stand.config.ts`: `7679e6e2f248bba017460e8fdbe02ac9fc8ec3a61662580ae42d7c1827f099bf`
- `web/tests/helpers/payment-network-guard.ts`: `a39defd0ecea2b49aa0afda1398427a4e0fceb4cc020257ca5c551ae4f2b9166`

Полный вывод команд, сборки и прогона сохранён в [сжатом логе](payment-regression-2026-10-21.log.gz). Его исходный размер — **57 093 байта**, gzip — **9 461 байт**. SHA-256 исходного текста и распакованного лога: `9f8b871adab9e501389903b5e7b5111a848ce8a1fb5554cfc42a15277aeeca94`; SHA-256 gzip: `a1d0cdb3c78d34521d1de08886648bf69a11f25980bbd6d4784883313bfbf0d9`. `gzip -t` прошёл.
