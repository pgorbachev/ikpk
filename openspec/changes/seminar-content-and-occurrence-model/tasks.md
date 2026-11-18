## 1. Подготовка и принятие контракта

- [ ] 1.1 Согласовать proposal, спецификацию и план с владельцем после независимого ревью; зафиксировать остаточные риски.
- [x] 1.2 Согласовать с владельцем макеты страниц и формы на desktop/mobile; зафиксировать все типы смысловых блоков.
- [ ] 1.3 Разрешить пересечения с `seminar-management-ux` и `cms-content-authoring-and-migration`, обновить дельты и доказать применимость относительно принятого порядка архивирования.
- [ ] 1.4 Разобрать все фактические шаблоны разметки, ссылки, медиа, документы и обе версии данных; готовить поимённые исключения только для остающихся активных правил, не для пустой продолжительности.
- [ ] 1.5 Получить редакторские решения для конфликтов цены (кроме подтверждённой неустановленной цены SER-1) и неоднозначного содержимого. Не требовать решения по NULL duration и не выводить часы из дат.

## 2. Тесты до реализации

- [ ] 2.1 Отдельному исполнителю написать и предъявить красные тесты сценариев формы, серверных ограничений, публикации, обратных связей и исторических преподавателей.
- [ ] 2.2 Написать красные тесты рендеринга и полной цепочки snapshot/import, offline/online и структурированных данных, включая пустую, нулевую и положительную цену и обе версии документа.
- [ ] 2.3 Подготовить тесты миграции с сохранением исходников, конфликтами, повторным запуском, сравнением ссылок, содержимого и статусов.
- [ ] 2.4 Добавить CMS save/publish/API-тесты: NULL/blank duration разрешены без seminar default; удаление default не блокируется. Сохранить проверки регистрации, учителей, связей, цены и остальных обязательных полей.
- [ ] 2.5 Добавить snapshot тесты: NULL duration без `missing-duration` exception валиден; trusted frozen registry с legacy missing-duration tombstones остаётся с прежним digest и не разрешает ни price, ни другое нарушение; новые registry candidates не содержат этот condition.
- [ ] 2.6 Добавить render tests для семинарской карточки, страницы «Расписание и цены», home event modules и preview: точный fallback «Продолжительность не задана», без записи fallback в CMS/snapshot и без часов, вычисленных из дат.
- [ ] 2.7 Добавить migration lineage tests: frozen v1 helpers/auditor hashes и inherited ledger остаются byte-for-byte неизменными и не replay-ятся; the exact eligible DB lineage/history selects a distinct v2 reviewed step; a later capture of that same lineage may proceed only with verified same history and newly bound snapshot digest/plan/receipt. Preserve empty-string vs SQL NULL exactly and emit no duration exception; v2 cannot be selected for inherited v1 lineage or duplicate step ID. Keep price review and all composition requirements active.

## 3. Реализация

- [ ] 3.1 Обновить только duration-specific CMS guards для nullable publication/removal; сохранить остальные серверные проверки при обычном UI и direct API.
- [ ] 3.2 Реализовать CMS-формы, автоматическую связь, фиксирование семинара и возврат; проверить отмену и несохранённый родитель.
- [ ] 3.3 Реализовать общий duration display helper и применить его ко всем существующим публичным потребителям; пустой effective value отображать как согласованный fallback.
- [ ] 3.4 Introduce a versioned snapshot contract for new captures: omit `missing-duration` violations and new exception candidates; validate an old pinned registry by its original full digest before treating its exact trusted duration rows as inert legacy tombstones. Preserve the pinned file/digest and all active price guards.
- [ ] 3.5 Добавить versioned `seminar-occurrence-model-v2` reviewed migration/auditor path for only the exact approved DB lineage/history (ID and hashes) without v1/v2 occurrence step; allow a later source snapshot from that same DB lineage only after rechecking the unchanged history and binding its fresh snapshot digest, plan and receipt. Fail closed for unknown/partial histories. Bind v2 in new receipt/cohort and test its composition/inherited continuation. Preserve existing v1 files, payload hashes, manifests, receipts and applied ledger; never replay v1. V2 does not normalize empty string and SQL NULL, and never calculates duration from dates or creates `duration-needs-review`. For any approved mapping of a blank seminar default, test mixed siblings: reject populating the default if any sibling has unknown prior effective duration; allow a sibling with a different explicit override only when its resulting effective value remains unchanged. Any approved nonempty override-to-default move has per-cell before/after evidence and preserves every occurrence effective value; price decisions are unchanged.

## 4. Проверка и поставка

- [ ] 4.1 На изолированной свежей copy/approved production DB restore проверить каждую версию, данные, медиа и активные price exceptions; сохранить отдельные environment/cohort/operation/snapshot/proof/receipt identities при сохранении исходного DB lineage ID; не переиспользовать staging receipts/manifest/registry и не записывать private payload в repo.
- [ ] 4.2 Провести независимые ревью кода, отдельный проход на переусложнение и предусмотренные проектом гейты; устранить согласованные находки.
- [ ] 4.3 Проверить порядок доставки на изолированной копии: web/build/import/refresh consumers с fallback и snapshot v2 до снятия CMS duration publish/removal guard; тестировать отказ/rollback после появления NULL без возврата несовместимого consumer; keep the writer fence through any DB restore, restore only within the no-new-writes window or reconcile and verify every post-backup edit before reopening writers, and test that later publications are not silently lost. Затем подготовить staging194 rollout/recovery с отдельными source-snapshot/operation/cohort identities без подмены исходного DB lineage ID; успех staging не является production acceptance.
- [ ] 4.4 После отдельного решения владельца выполнить приёмку и архивировать change с проверкой пересечений и переносом требований в основные спецификации.
