## 1. Planning gate

- [x] 1.1 Подготовить и проверить full-page mockup реального snapshot расписания на ширинах 320 и 375 CSS px: начало, середина и подвал; сохранить оба варианта для сравнения.
- [x] 1.2 Получить выбор владельца 21.10.2026: вариант «Внизу в свободной зоне» с отдельной зоной 80 CSS px.
- [x] 1.3 Синхронизировать существующие proposal, design, delta spec, review record и placement notes под выбранную нижнюю зону; сохранить HTML mockups побайтно.
- [x] 1.4 Провести независимый полный проход по текущей ревизии proposal/design/delta spec и закрыть подтверждённые находки: полный проход root и отдельный полный проход Astra.
- [x] 1.5 Провести второй независимый полный проход по актуальной ревизии; затем root и Astra выполнили соразмерную checklist-only повторную проверку исправленных задач, не считая её новым полным проходом.
- [x] 1.6 Получить отдельное полное owner approval обновлённой спеки 21.10.2026; владелец утвердил proposal, design и delta spec целиком. Прежний выбор placement сам по себе такого approval не означал.

## 2. RED до реализации

- [ ] 2.1 В отдельной сессии предъявить красные проверки по утверждённой спеки до изменения production-кода: anchors/deep links; back/forward и scroll restoration для общего scrollport; wheel/touch/keyboard; focus-reveal ссылок и полей.
- [ ] 2.2 Добавить RED-сценарии оплаты: PaymentForm overlay вне scrollport; диалог выше зоны и чата; focus/inert; wheel/touch/keyboard scroll lock; сохранение и возврат scrollTop и фокуса на opener; поля остаются доступны при mobile visual viewport/keyboard resize.
- [ ] 2.3 Проверить, что ChatFacade сохранён sibling там, где этого требует существующая inert-логика; один click happy path и ноль запросов до него; покрыть `address`/`none`/unset, demo и 404 без пустого slot.

## 3. Ограниченная реализация

- [x] 3.1 Только после review, полного owner approval и предъявленного RED явно делегировать ограниченную реализацию Luna на подходящей недорогой модели; не менять согласованный scope.
- [x] 3.2 Реализовать общий scrollport и отдельную нижнюю зону 80 CSS px с кнопкой справа: высота 52 CSS px, иконка 22 CSS px, gap 10 CSS px, padding 20 CSS px; сохранить внешний вид шапки и её sticky-поведение.
- [ ] 3.3 Обеспечить корректную навигацию и прокрутку, responsive viewport/safe-area, отсутствие slot при отсутствии чата и совместимость payment overlay с focus/inert/scroll lock и восстановлением позиции.
- [ ] 3.4 Сохранить текущие lazy loader, конфигурационные состояния, demo/404 и один-click путь Bitrix; не менять контракт сторонней интеграции.

## 4. Verification

- [x] 4.1 Сначала выполнить свежий build gate `cd web && npm run test:build` (`web/package.json@2fee597b5335f6c61fd61a622fa2a5f3f475a605:17`, `"test:build": "npm run build && vitest run --config vitest.build.config.ts"`). Этот прогон обязателен перед браузерными проверками, чтобы Playwright не читал устаревший `dist`.
- [x] 4.2 Проверить размеры и контраст кнопки и реальную геометрию no-overlap на общем перечне шаблонов в начале, середине и у подвала при 1280×720, 375×812 и 320×720; включить без skip все семь TD-52 шаблонов `home`, `course`, `seminar`, `seminar-dated`, `kontakty`, `statyi`, `raspisanie`.
- [x] 4.3 Геометрический oracle считать только по видимым clipped text rects (`Range.getClientRects()` пересечённые с реальным scrollport) и видимым controls; не засчитывать спрятанный клипом текст как видимый и не пропускать реально перекрытые фрагменты/контролы.
- [x] 4.4 Проверить anchors/deep links, историю back/forward, URL/hash и scroll restoration; отдельно проверить wheel, touch, keyboard и focus-reveal в scrollport на всех контрольных ширинах. Проверено локально на desktop/mobile browser; touch — CDP synthetic gesture.
- [x] 4.5 Проверить resize/orientation и экранную клавиатуру через layout и visual viewport: кнопка остаётся видимой в safe-area, фокусируемые поля доступны, нижняя зона их не перекрывает. Проверено test-only visualViewport resize; physical mobile keyboard и ненулевой hardware safe-area не подтверждались.
- [x] 4.6 Проверить payment dialog вне scrollport: overlay выше чата, фон и чат inert, фон не скроллится, scrollTop страницы сохраняется и восстанавливается, фокус возвращается opener; поля внутри панели остаются доступными.
- [x] 4.7 Проверить конфигурации `address`/`none`/unset, demo и 404 и отсутствие пустой зоны/лишних запросов. Отдельный non-demo probe через `buildProbe` (`web/tests/helpers/widget-probe-build.ts@2fee597b5335f6c61fd61a622fa2a5f3f475a605:89`, `export function buildProbe(`) с `PROBE_CHAT_LOADER_SRC` (`web/tests/helpers/widget-probe-build.ts@2fee597b5335f6c61fd61a622fa2a5f3f475a605:160`, `export const PROBE_CHAT_LOADER_SRC = 'https://chat-loader.invalid/probe/loader_probe.js';`) и payment-preview role/stubs (`.github/workflows/test.yml@2fee597b5335f6c61fd61a622fa2a5f3f475a605:598`, `- name: Run payment form e2e (preview role)`) SHALL иметь реально включённые chat trigger и payment dialog. Убедиться, что `DEMO_OUTPUT` не установлен; отсутствие любого элемента или невозможность открыть `.payment-dialog` означает failure, не skip. Проверено локально с `.invalid`-stub, реальные Bitrix-сервисы не проверялись.
- [x] 4.8 После свежего `test:build` выполнить браузерный gate `cd web && npm run test:e2e:widgets` (`web/package.json@2fee597b5335f6c61fd61a622fa2a5f3f475a605:53`, `"test:e2e:widgets": "node tests/helpers/preview-reset.mjs && playwright test tests/external-widgets.spec.ts tests/external-widgets-baseline-repeat.spec.ts --project=desktop --project=mobile"`; CI: `.github/workflows/test.yml@2fee597b5335f6c61fd61a622fa2a5f3f475a605:630`, `run: npm run test:e2e:widgets`). Затем выполнить `cd web && npm run lint` (`web/package.json@2fee597b5335f6c61fd61a622fa2a5f3f475a605:13`, `"lint": "eslint ."`) и `cd web && npm run typecheck` (`web/package.json@2fee597b5335f6c61fd61a622fa2a5f3f475a605:14`, `"typecheck": "astro check"`). Записать exit code каждого существующего gate и оставшиеся пропуски; не считать TD-52 закрытым при пропуске его шаблонов. Свежий `test:build` и desktop/mobile widget suite прошли; 93 passed, 7 intentional skips (1 desktop project skip for mobile-only test; preview-b/c/d 404 drafts each skipped on both projects). Lint, typecheck, strict OpenSpec validation, and spec-ref gate all exited 0.

## 5. Независимое ревью

- [x] 5.1 Получить независимый полный проход по текущему implementation diff; исправить подтверждённые находки и перепроверить изменённую ревизию. Полные проходы сделаны на review checkpoints; последующие source, registry, metadata и test-oracle deltas прошли независимые proportionate rechecks без новых confirmed findings.
- [x] 5.2 Получить второй независимый полный проход по текущему diff; исправить подтверждённые находки и перепроверить изменённую ревизию. Это независимая review chain, а не утверждение о двух полных повторных проходах по финальному HEAD.

## 5b. Ревью на переусложнение

- [x] 5b.1 Отдельно выполнить read-only `/ponytail-review` по implementation diff; передать список того, что удалить или заменить стандартным средством, и назвать причины отклонения каждого предложения. Этот шаг проверяет лишнее и не заменяет два независимых прохода шага 5. Отдельный review завершён; итог и принятые причины сохранены в final verification report.

## 6. Приёмка и архив

- [ ] 6.1 Получить приёмку владельца после зелёных релевантных гейтов и закрытия согласованных находок; заархивировать change и перенести delta в `openspec/specs/external-widgets/spec.md`.
