## 1. Зафиксировать baseline

- [ ] 1.1 В test-only worktree на SHA `2d48e84db36c013fabcbbe9ba389e1f4debca639` сохранить машинно проверяемый реестр всех `set:html`, отдельно классифицировав rich-content и JSON-LD sink-и.
- [ ] 1.2 Построить структурный fingerprint всего текущего rich HTML: текст, заголовки, списки, таблицы, `time[datetime]`, безопасные ссылки и изображения, `details`, RUTUBE и сгенерированные `tabindex`/`data-*` маркеры; сохранить fixture/ожидания рядом с тестами.
- [ ] 1.3 Повторно сверить пересекающиеся `architecture-frame-prototypes` и `online-payment-flow`; если один из них приземлился, rebase-нуть baseline до написания тестов и обновить реестр sink-ов.
- [ ] 1.4 Зафиксировать current known deviation `https://ikpk.su/api/upload/file/0acd713c-1477-4c6c-93ad-1596d2a17304`, перенести asset через существующий media pipeline в `/media/**` и доказать его наличие в manifest до финального characterization.

## 2. Написать тесты в отдельной чистой сессии до реализации

- [ ] 2.1 Добавить unit-тесты политики для разрешённых элементов/атрибутов, `time[datetime]`, точных системных `tabindex`/`data-*`, удаления активных поддеревьев, `on*`, `style`, `srcdoc`, XML/XLink и неизвестных контейнеров.
- [ ] 2.2 Добавить параметризованную матрицу URL: регистр, HTML-сущности, управляющие символы, credentials/query confusion, protocol-relative URL, разрешённые `a`/`img` назначения и fail-closed `srcset`.
- [ ] 2.3 Добавить тесты нормализации `target`/`rel`, точного RUTUBE origin/path и фиксированных iframe permissions, включая похожие hostname, порт, credentials, query и попытку ослабить sandbox.
- [ ] 2.4 Добавить oversized/deep/wide/malformed fixtures для лимитов 2 MiB, 50 000 nodes, depth 256 и безопасного сообщения об ошибке с ID материала.
- [ ] 2.5 Добавить тест идемпотентности и characterization-тест текущего каталога по fingerprint из 1.2.
- [ ] 2.6 Расширить source collector на Astro и TypeScript: разрешить `set:html` только центральному компоненту, запретить `is:raw`, непустой/вычисляемый `innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`, `createContextualFragment`, HTML `DOMParser`, `srcdoc`, `setHTMLUnsafe` и внешние `as SafeRichHtml`; четыре существующих `innerHTML = ''` оставить точными исключениями, а JSON-LD — под существующим invariant.
- [ ] 2.7 Добавить component render test, который проводит hostile fixture и поддельный brand через реальный cleaner и обязательную повторную санитизацию центрального компонента до итогового HTML.
- [ ] 2.8 Добавить независимый parsed-output gate для `dist` и `dist-demo`: не импортировать runtime allowlist/URL validator, разбирать только `data-safe-rich-content`, сообщать путь страницы и нарушение.
- [ ] 2.9 Предъявить RED-прогон новых тестов на неизменённом production-коде и для каждого нового gate показать контролируемую негативную мутацию, включая непустой `innerHTML` и ошибочное расширение общей policy.

## 3. Реализовать границу безопасности другим исполнителем

- [ ] 3.1 Выбрать совместимую поддерживаемую версию серверного allowlist-санитайзера; проверить maintenance/provenance и каждый advisory во всём parser subtree независимо от severity, зафиксировать version/integrity в `web/package-lock.json` и согласовать обновления с `dependency-update-gates`.
- [ ] 3.2 Реализовать preflight-лимиты и единую закрытую политику элементов, атрибутов и URL, удаление активных поддеревьев, fail-closed ошибки с типом/ID материала и opaque `SafeRichHtml` как последнюю стадию `cleanBodyHtml()`.
- [ ] 3.3 Реализовать детерминированный transform для ссылок, изображений, `srcset`, `target="_blank"` и фиксированного RUTUBE capability.
- [ ] 3.4 Добавить `RichContent.astro`, принимающий `SafeRichHtml`, обязательно повторно санитизирующий его в sink-е, владеющий не-JSON-LD `set:html` и ставящий `data-safe-rich-content`.
- [ ] 3.5 Перевести все 13 текущих не-JSON-LD sink-ов на `RichContent.astro`, передать каждому стабильные тип/ID материала и сохранить CSS-классы, test selectors и layout; JSON-LD оставить под `serializeJsonLd()`.
- [ ] 3.6 Подключить source и parsed-output gates к обязательным локальным/CI-командам для production- и demo-сборки.

## 4. Проверить поставку

- [ ] 4.1 Добиться зелёного `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:build` и `npm run test:demo` в `web/`.
- [ ] 4.2 Выполнить `npm run audit:prod`, отдельно разобрать все advisory sanitizer/parser subtree с risk acceptance только по явному решению владельца и подтвердить, что санитайзер не попал в browser bundle.
- [ ] 4.3 Сравнить fingerprint текущего каталога и вручную проверить существующий RUTUBE player на изолированном тестовом стенде; сохранить URL/вывод/снимок как свидетельство.
- [ ] 4.4 Повторить негативную верификацию: временно обойти границу и отдельно разрешить hostile payload, убедившись, что обязательные проверки падают; затем вернуть мутации и повторить зелёный прогон.

## 5. Независимое ревью и приёмка

- [ ] 5.1 Провести независимое security review соответствия реализации каждому requirement/scenario и исправить подтверждённые находки.
- [ ] 5.2 Провести независимое review полноты миграции sink-ов, совместимости текущего контента и CI-гейтов; исправить подтверждённые находки.
- [ ] 5.3 После исправлений повторить все гейты раздела 4 и зафиксировать точный SHA проверенной реализации.
- [ ] 5.4 Повторно сверить активные пересекающиеся changes, обновить их артефакты/реализацию относительно нового sink-контракта и проверить их строгую применимость.
- [ ] 5.5 Обновить runbook: после подключения CMS/import разрешать только sanitizer-enabled rollback, maintenance page или roll-forward с остановкой ingestion, проверкой output и очисткой caches.
- [ ] 5.6 После приёмки владельцем архивировать change и проверить перенос `rich-content-safety` в main specs.
