## ADDED Requirements

### Requirement: Host helper is installed from a provenance-bound release artifact

The host helper SHALL be packaged as `host-helper.tar.gz` from the existing installer, modules, and configuration templates. Its CI evidence SHALL bind it to the exact canonical `main` head SHA and successful `Tests` push run and attempt. Artifact retrieval SHALL reuse the existing CMS artifact admission checks: exactly one artifact for the run, unexpired, bound to its workflow run/head SHA, GitHub's digest for the downloaded ZIP verified, and exactly the expected helper payload in that ZIP. The verified payload SHA-256 SHALL be recorded for the operation. CI SHALL upload the artifact without host credentials. Staging194 may use the exact-SHA CI artifact without a GitHub Release; production SHALL use the same payload bytes attached to the GitHub Release, and SHALL verify the Release asset SHA-256 matches the verified CI payload SHA-256. Destination configurations remain separate. Installation SHALL use the existing installer and SHALL NOT replace installed lock/configuration state, weaken admission gates, or introduce a new delivery service or transport. The existing operator has no self-update behavior. Installation SHALL proceed only over an existing channel proven to be permitted for the destination; an unknown or forbidden channel SHALL cause refusal before installation. Calling the installed helper remotely is not by itself evidence that helper-update delivery is available.

#### Scenario: staging194 installs the exact CI artifact

- **WHEN** the exact canonical `main` head SHA, successful `Tests` push run/attempt, unique unexpired run-bound artifact, downloaded ZIP GitHub digest, and exact expected helper payload all verify, and an existing delivery channel is proven permitted
- **THEN** the existing explicit staging194 publication command obtains/verifies that CI artifact, invokes the existing installer through the proven channel, and continues the existing publication flow
- **AND** staging194-specific configuration remains separate
- **AND** acceptance verifies the actually served release and required routes

#### Scenario: production reuses the CI artifact in a GitHub Release

- **WHEN** the verified CI helper payload for an exact SHA is attached to its GitHub Release, the Release asset SHA-256 matches the verified CI payload SHA-256, and an existing delivery channel is proven permitted
- **THEN** production installs those same artifact bytes through the existing installer with production-specific configuration

#### Scenario: artifact channel is not permitted

- **WHEN** the artifact channel is forbidden or unknown for the destination, the exact-SHA/CI/integrity evidence is missing, or the production Release asset digest differs from the verified CI payload
- **THEN** the existing publication command refuses before installation or changing installed helper, lock, or configuration state; if no permitted delivery channel can be evidenced, the change remains blocked on that concrete channel decision

## MODIFIED Requirements

### Requirement: Публикация только после успешного прогона тестов

Успешный canonical push `Tests` run является необходимым свидетельством, но SHALL NOT запускать публикацию. Каждая публикация требует явной команды оператора вне GitHub Actions. CI SHALL NOT иметь host credentials. Для ordinary production публикации команда принимает только exact full SHA на canonical `main`, текущую main head и успешный run, где все обязательные jobs завершились успешно без `skipped` или `cancelled`. Отдельный approved `initial-prod` профиль использует тот же gate для exact current `main`, но закреплён за одним protected operation ID и production destination и становится permanently unavailable после commit. Для paired rehearsal staging194 по умолчанию выбирается exact full SHA текущего canonical `main`; оператор может явно выбрать полный SHA, остающийся предком canonical `main`. Для выбранного SHA обязательны успешные четыре canonical push CI workflow с записанными run/attempt; GitHub Release и `release-preflight` не требуются. Выбранный SHA фиксируется за operation, CMS и static outputs используют его один; дальнейшее продвижение `main` само по себе не отменяет операцию, но потеря ancestry SHALL приводить к отказу. Совместимость миграции проверяется на candidate после fence и проверенного backup; при отсутствии подтверждения переключение SHALL NOT выполняться, а fenced recovery state сохраняется. Owner-approved staging194 static-only mode (`194.226.99.10`) requires exact current canonical `main` full SHA and successful push runs for `Tests`, `Lint and Typecheck`, `Security`, and `Lighthouse CI`, including successful required jobs without `skipped` or `cancelled`. For the shared tag-based production-static operator workflow (`--release-tag` plus validated in-memory Release admission), the default source is the green exact full SHA on canonical `main` at operation start; an operator may explicitly select an older stable published GitHub Release when the same four push workflows pass for that exact SHA and existing compatibility checks pass. The workflow records applicable run/attempt and Release evidence and continues with its tag-admitted SHA if `main` advances later. The legacy direct production-static `static-main` path without `--release-tag` retains its current-main pre-switch check. Both modes update only static output; production-static uses separate config, state, and capture namespaces. Run ID и attempt фиксируются. Для всех режимов у назначенной публикации записываются соответствующие SHA, CI evidence и digests. Перед ordinary production release CMS/static source tree SHALL совпадать после curated squash в `main`, но новый main SHA требует собственного canonical `Tests` run. GitHub Release и `release-preflight` SHALL завершиться до production deployment.

#### Scenario: тесты прошли и коммит остаётся вершиной

- **WHEN** canonical обязательный run успешен для текущего source SHA
- **THEN** публикация не запускается до явной локальной команды

#### Scenario: staging194 paired uses an explicitly selected revision without Release

- **WHEN** the operator selects a full SHA that remains on canonical `main` and its four exact-SHA push workflows succeeded
- **THEN** paired staging194 admits and pins that SHA without a GitHub Release or `release-preflight`
- **AND** a later advance of `main` does not replace the pinned SHA
- **AND** missing ancestry, CI or compatible artifact evidence causes refusal before fencing
- **AND** migration compatibility is checked after fence and verified backup; absent evidence refuses activation and preserves fenced recovery

#### Scenario: тесты прошли, но коммит уже перекрыт

- **WHEN** source SHA is no longer the current canonical head at command time in a source-selection mode that requires a current head (ordinary production, initial-prod, staging194 static-only, or legacy direct production-static without `--release-tag`)
- **THEN** команда отказывает до host mutation

#### Scenario: тесты упали

- **WHEN** обязательный run завершился неуспехом
- **THEN** публикация не запускается

#### Scenario: прогон отменён

- **WHEN** run или обязательный job отменён либо пропущен
- **THEN** команда отказывает

#### Scenario: ручной запуск не обходит прогон

- **WHEN** оператор запускает публикацию вручную без точного успешного run
- **THEN** команда отказывает до исполнения candidate code

#### Scenario: только exact source и полный зелёный run допускают команду

- **WHEN** оператор выбирает ordinary production SHA, fixed initial-prod SHA, staging194 paired rehearsal SHA, staging194 static-only main SHA, production-static SHA through the tag-based operator workflow, or a production-static SHA through the legacy direct no-tag path
- **THEN** команда подтверждает назначенный canonical ref (including the selected Release tag where applicable), exact full SHA, run/attempt и успех всех обязательных jobs без пропусков или отмен
- **AND** несовпадение отказывает до исполнения candidate code или host mutation

### Requirement: Ручная публикация остаётся доступной

Публикация доступна только явной локальной команде доверенного оператора. GitHub `workflow_dispatch`, `workflow_run`, CMS webhook и календарное событие SHALL NOT публиковать сайт. Команда SHALL закрепить назначение и source до исполнения candidate code, проверить admission по предыдущему требованию, построить static candidate на сервере из admitted SHA как непривилегированный пользователь, выполнить local candidate checks для sealed snapshot и записать их исход вместе с source, snapshot и digest. Browser checks SHALL use the same sealed static bytes later served; canonical CI run proves the source SHA, а local checks prove the captured content pair. Для paired staging194 rehearsal CMS update и static publication используют один operation ID и fence; global commit разрешён только после приёмки обоих. До commit разрешена только явная recovery; после commit восстановление старой DB запрещено. Существующие production rules для provenance, freshness и подтверждённого rollback сохраняются за пределами scoped staging194 исключений.

Для staging194 static-only и production-static команда использует свежий read-only CMS/content/media capture и выполняет необходимые локальные и browser checks той же static-кандидатуры. Она SHALL switch только `currentStatic`; CMS release/symlink, service, environment, DB/WAL, uploads и CMS identities SHALL оставаться неизменными. Режим не требует CMS-кандидата, CMS-миграции, paired CMS/static SHA или writer fence; отдельный durable journal сохраняет старый static tree, а rollback требует явной причины и восстанавливает его только если pointer всё ещё указывает на принятый candidate. Production-static запрещает CMS-mutating commands. Paired staging194 rehearsal uses the source admission defined above; ordinary production admission remains unchanged.

#### Scenario: ручной запуск, вершина не сдвинулась

- **WHEN** оператор запускает проверенную пару для допущенного source
- **THEN** локальная команда проверяет admission и candidate; hosted workflow не публикует

#### Scenario: новейшая проверенная пара отстала от контента

- **WHEN** production provenance показывает более новое состояние контента
- **THEN** команда отказывает, кроме явно подтверждённого rollback

#### Scenario: staging194 static-only main preserves CMS

- **WHEN** exact current `main` SHA has successful `Tests`, `Lint and Typecheck`, `Security`, and `Lighthouse CI` runs and the read-only CMS/content/media capture plus static candidate checks pass
- **THEN** the operator command atomically serves the candidate static tree on staging194
- **AND** the existing CMS code, service, environment, DB/WAL, uploads, roles, and users remain unchanged without a writer fence or paired CMS update
- **AND** explicit rollback restores the exact prior static tree only while the current pointer still identifies this candidate

#### Scenario: production-static source preserves CMS

- **WHEN** the shared tag-based workflow's current-main SHA fixed at operation start, or explicitly selected stable older Release SHA, passes all four required workflows for that exact SHA and production-static capture plus candidate checks pass; or the legacy direct no-tag path's exact current-main SHA passes all four required workflows, remains current through its pre-switch check, and production-static capture plus candidate checks pass
- **THEN** the operator atomically serves only the candidate static tree on production
- **AND** CMS code, service, environment, DB/WAL, uploads, roles, and users remain unchanged
- **AND** CMS-mutating actions refuse before host mutation and explicit rollback uses the separate production-static journal

#### Scenario: для вершины проверенной пары нет

- **WHEN** нет проверенной пары для выбранной production вершины
- **THEN** команда отказывает

#### Scenario: подтверждённый откат на более старую проверенную пару

- **WHEN** оператор выбирает сохранённую ранее проверенную пару, указывает причину и подтверждает rollback
- **THEN** локальная команда проверяет исходное свидетельство, целостность артефакта и применимость назначения

#### Scenario: пара старше срока хранения не выкладывается

- **WHEN** требуемый production snapshot или media уже истёк
- **THEN** команда отказывает

#### Scenario: откат без подтверждения не выполняется

- **WHEN** более старая production pair запрошена без причины или явного подтверждения
- **THEN** команда отказывает

#### Scenario: ручной запуск, вершина сдвинулась во время сборки

- **WHEN** source identity меняется во время подготовки candidate
- **THEN** команда отказывает до host mutation

### Requirement: Устаревший результат не откатывает сайт

An operator publication command whose source-selection mode requires the current canonical head SHALL recheck that its exact SHA remains that head immediately before the atomic switch; a stale run SHALL NOT publish. This includes the legacy direct production-static `static-main` path without `--release-tag`. The shared tag-based production-static workflow (`--release-tag` plus validated in-memory Release admission) fixes its source SHA at operation start and SHALL NOT recheck whether that SHA remains current before switching. State-changing publication, deploy, restore, cleanup, and CMS refresh commands for a target site SHALL use its same existing host flock as the single shared writer gate; journal-specific locks protect journal integrity and do not replace this gate. GET and status requests SHALL NOT wait for a busy shared writer gate or mutate operation/site state while another state-changing operation holds it. An existing nonblocking probe MAY acquire the gate briefly to diagnose an unresolved same-process Restore. This does not promise availability while an existing journal-specific lock is held. Each state-changing command SHALL acquire the flock before inspecting durable operation state for admission. A competing command MAY wait for the flock, then SHALL repeat admission under the acquired lock. Read-only cleanup-profile selection is not admission and SHALL NOT require the writer gate. Admission SHALL fail closed when durable state shows an active or unfinished operation, except for an already-supported continuation or recovery that verifies the existing operation identity where one is defined. Cleanup MAY complete an already-confirmed terminal cleanup-pending operation under the lock; admission relies on that verified terminal state, never on deleting or resetting its marker or journal. Cleanup under the lock SHALL preserve `current` and rollback targets protected by the existing contract or an unfinished operation. A process restart or released OS flock does not by itself clear unfinished state. Operations whose existing contract requires a storage-space preflight SHALL complete it before their first mutation; this requirement does not add a space preflight to restore or cleanup. Preserve existing rollback confirmation, target checks, and verified backup requirements. If the source advances after the final applicable head check, the selected release remains identifiable by its exact SHA and the site is not automatically changed again. Returning to the new head requires a new explicit local command and the checks applicable to that source-selection mode. An older production pair remains available only through the separately confirmed rollback path; its original CI and artifact evidence must remain valid. The tag-based production-static workflow's explicit older stable Release selection is governed by its exact-SHA CI and compatibility checks above.

#### Scenario: вершина сдвинулась, пока шла сборка

- **WHEN** the admitted SHA is no longer the canonical head at the final pre-switch check for a source-selection mode that requires a current head
- **THEN** publication refuses before switching

#### Scenario: вершина сдвинулась после последней сверки

- **WHEN** the canonical branch advances during the atomic switch after the last successful check
- **THEN** the served release remains one identified candidate; no automatic follow-up publication occurs

#### Scenario: перезапуск старого прогона

- **WHEN** a successful test run is restarted for a SHA that is no longer the admitted head in a source-selection mode that requires a current head
- **THEN** the local command refuses to publish it

#### Scenario: подтверждённый откат на перекрытый коммит

- **WHEN** an operator explicitly selects a retained older pair, supplies a reason, and confirms rollback
- **THEN** the local command verifies the original CI and artifact evidence and records the rollback

#### Scenario: событийный путь исключением не пользуется

- **WHEN** an automated CI or CMS event requests publication of a superseded pair
- **THEN** no publication occurs; only the separate confirmed operator rollback path can select an older pair

### Requirement: Объём гейта назван явно

Documentation SHALL list the checks required before an operator publication. A check outside the canonical `Tests` workflow does not block a command only when all mandatory CI jobs passed and the local checks for the exact candidate pair pass. The local command SHALL record its gate results; moving a required check outside the canonical workflow without updating this list is not allowed.

#### Scenario: проверка вне гейта завершилась неудачей

- **WHEN** a check outside the canonical CI gate fails, the exact mandatory run succeeds, and an operator starts publication with a candidate that passes local checks
- **THEN** that check does not block publication, and the process documentation identifies it as outside the gate; CI success alone still does not publish

### Requirement: Более старое состояние контента не публикуется поверх более нового

Production SHALL compare the snapshot content revision with the provenance high-water mark. A revision below the mark SHALL require explicit operator confirmation and a local command. Distinguish stale capture (a journal record newer than the snapshot's observed record) from restore regression (observed record is latest but revision is below the mark): stale capture always refuses and is recorded; it cannot be overridden by confirming the old snapshot. Tests may run on the latest state, but SHALL NOT publish it automatically. A local publication command checks the current source/snapshot pair; failed checks leave the site unchanged.

Confirming a restored CMS state SHALL append the existing acceptance event and advance the provenance mark. Publishing an older saved site release SHALL record the rollback but SHALL NOT mark CMS content accepted, because the database did not change. After that rollback, calendar or content checks do not return the site automatically; the accepted older site remains until a separate local command publishes the checked current CMS state. Each later restore below the mark requires its own confirmation. This rule preserves the production journal and high-water-mark contract; the staging194 frozen-capture exception is scoped by `cms-content-source`.

#### Scenario: устаревший снимок отменяется без участия человека

- **WHEN** operator candidate snapshot has a journal record newer than its observed record
- **THEN** the local command refuses and records the reason; confirming the old snapshot cannot override staleness

#### Scenario: новое состояние не прошло проверки

- **WHEN** checks for the latest journal state fail
- **THEN** the site remains unchanged and the unpublishable state is reported

#### Scenario: восстановление базы не считается устареванием

- **WHEN** a restored DB snapshot observes the latest journal record but its content revision is below the mark
- **THEN** it is classified as restore regression and requires explicit confirmation

#### Scenario: база восстановлена из резервной копии

- **WHEN** a DB backup is restored and a check runs
- **THEN** the snapshot is below the high-water mark and no publication occurs before confirmation and a local command

#### Scenario: явное подтверждение разрешает публикацию

- **WHEN** a trusted operator confirms a restored state below the mark and starts the local command
- **THEN** acceptance is recorded with the revision and mark, and the current checked pair may publish

#### Scenario: ручная выкладка старой пары не пишет в журнал происхождения

- **WHEN** an operator explicitly rolls back to an older saved site pair
- **THEN** the rollback is recorded, but no CMS acceptance event is added; restoring current CMS content later requires another local command

#### Scenario: после принятого отката обычные прогоны не требуют подтверждения

- **WHEN** a calendar check runs after an accepted rollback on unchanged content
- **THEN** the site does not change automatically; another local command is required to publish

#### Scenario: второй откат подряд снова требует подтверждения

- **WHEN** the CMS database is restored to a still older state after a prior acceptance
- **THEN** publication stops until the operator separately confirms that restore

### Requirement: Внешний триггер не выбирает, что собирать

Аутентифицированное CMS оповещение MAY запросить только проверки canonical source; оно SHALL NOT выбирать ref, SHA, назначение или candidate и SHALL NOT публиковать сайт. Неаутентифицированный запрос игнорируется. Даже успешная проверка требует отдельной локальной команды оператора для публикации.

#### Scenario: запрос без действительной аутентификации игнорируется

- **WHEN** приходит CMS оповещение без действительной аутентификации
- **THEN** проверки не запускаются и сайт не меняется

#### Scenario: параметры запроса не влияют на собираемое

- **WHEN** аутентифицированное оповещение содержит ref, SHA или назначение
- **THEN** параметры игнорируются, CMS может запросить только проверки canonical source, и публикация не происходит

### Requirement: Публикуется только проверенное содержимое

Опубликованная пара SHALL содержать CMS-снимок, собранный из точного допущенного source SHA и
опорной даты. Успешный canonical push `Tests` подтверждает source SHA и обязательные CI jobs;
локальные проверки оператора и browser checks подтверждают собранную запечатанную пару
CMS/static. Browser checks SHALL читать те же sealed static bytes, которые будут обслуживать
сайт; они выполняются off-host на машине оператора, вне CI, и не используют deployment credentials. Перед переключением
команда повторно проверяет admission. Если CMS изменилась после capture, текущая команда
отказывает: новое содержимое требует нового capture и проверок, автоматическая публикация не
запускается.

#### Scenario: во время прогона в ветку приехал новый коммит

- **WHEN** canonical run прошёл для source SHA A, но к моменту локальной команды назначенный ref уже указывает на B
- **THEN** команда отказывает до host mutation; CI не публикует A или B

#### Scenario: проверенный коммит остаётся вершиной

- **WHEN** exact admitted SHA остаётся вершиной, canonical run успешен, и локальные проверки включая browser checks прошли для sealed CMS/static pair
- **THEN** команда обслуживает только эту пару; browser checks использовали те же static bytes, которые будут обслуживаться

#### Scenario: во время прогона изменён контент

- **WHEN** live CMS content отличается от sealed snapshot перед переключением
- **THEN** команда отказывает до публикации; новое содержимое требует нового capture и проверок

### Requirement: Опубликованное состояние сайта одно

Для production SHALL быть один доверенный локальный operator entrypoint; CI и hosted workflows
не публикуют и не получают host deployment credentials. При переходе со старого пути он может
оставаться доступен только до проверки новой раздачи. Старый путь и его права отключаются после
того, как запрос по имени целевой раздачи вернул 200 без смены hostname и раздача объявила
ожидаемый `release.json` commit. Наблюдение SHALL проверять именно целевую раздачу.

#### Scenario: прежний путь публикации остался

- **WHEN** операторский entrypoint не стал единственным production-путём после проверки новой раздачи
- **THEN** старый путь и его права отключаются; hosted publication отказывает

#### Scenario: путей публикации не найдено

- **WHEN** целевой operator entrypoint отсутствует
- **THEN** приёмка отказывает, а отсутствие публикации не считается успешной проверкой

#### Scenario: наблюдение осталось на прежней площадке

- **WHEN** наблюдение не проверяет целевую раздачу и её ожидаемый `release.json` commit
- **THEN** публикация не принимается как проверенная

#### Scenario: новая раздача ещё не подтверждена достижимой

- **WHEN** целевая раздача не возвращает ожидаемый ответ и release commit
- **THEN** прежний путь не отключается

#### Scenario: раздача отвечает, но не тем

- **WHEN** целевая раздача отдаёт ошибку, другой hostname или неожиданный release commit
- **THEN** новая публикация не считается подтверждённой и прежний путь остаётся доступным

## REMOVED Requirements

### Requirement: Изменение состояния сайта по календарю публикуется без правки контента

**Reason**: календарное событие больше не является разрешением на публикацию; содержимое меняется только после явной операторской команды.

**Migration**: календарные проверки могут готовить CI evidence, но публикация требует локальной команды.

### Requirement: Изменение контента приводит к публикации через обязательный прогон

**Reason**: проверка изменения контента не должна запускать автоматическую публикацию; успешный CI остаётся необходимым свидетельством для последующей операторской команды.

**Migration**: content changes могут запускать проверки; результат CI не меняет сайт.
