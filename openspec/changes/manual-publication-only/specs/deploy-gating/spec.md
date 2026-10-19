## MODIFIED Requirements

### Requirement: Публикация только после успешного прогона тестов

Успешный canonical push `Tests` run является необходимым свидетельством, но SHALL NOT запускать публикацию. Каждая публикация требует явной команды оператора вне GitHub Actions. CI SHALL NOT иметь host credentials. Для ordinary production публикации команда принимает только exact full SHA на canonical `main`, текущую main head и успешный run, где все обязательные jobs завершились успешно без `skipped` или `cancelled`. Отдельный approved `initial-prod` профиль использует тот же gate для exact current `main`, но закреплён за одним protected operation ID и production destination и становится permanently unavailable после commit. Для rehearsal принимается только owner-designated full SHA на canonical `dev` с exact-SHA push run того же canonical `Tests` workflow; этот допуск закреплён за staging194 (`194.226.99.10`) и не даёт ordinary production admission. Run ID и attempt фиксируются. CMS и static outputs для одного назначения SHALL происходить из одного source SHA и иметь отдельные digests. Перед production release CMS/static source tree SHALL совпадать после curated squash в `main`, но новый main SHA требует собственного canonical `Tests` run. GitHub Release создаётся после успешного production deployment.

#### Scenario: тесты прошли и коммит остаётся вершиной

- **WHEN** canonical обязательный run успешен для текущего source SHA
- **THEN** публикация не запускается до явной локальной команды

#### Scenario: тесты прошли, но коммит уже перекрыт

- **WHEN** source SHA перестал быть допущенным head к моменту команды
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

- **WHEN** оператор выбирает ordinary production SHA, fixed initial-prod SHA или staging194 rehearsal SHA
- **THEN** команда подтверждает назначенный canonical ref, exact full SHA, run/attempt и успех всех обязательных jobs без пропусков или отмен
- **AND** несовпадение отказывает до исполнения candidate code или host mutation

### Requirement: Ручная публикация остаётся доступной

Публикация доступна только явной локальной команде доверенного оператора. GitHub `workflow_dispatch`, `workflow_run`, CMS webhook и календарное событие SHALL NOT публиковать сайт. Команда SHALL закрепить назначение и source до исполнения candidate code, проверить admission по предыдущему требованию, построить static candidate на сервере из admitted SHA как непривилегированный пользователь, выполнить local candidate checks для sealed snapshot и записать их исход вместе с source, snapshot и digest. Browser checks SHALL use the same sealed static bytes later served; canonical CI run proves the source SHA, а local checks prove the captured content pair. Для rehearsal CMS update и static publication используют один operation ID и fence; global commit разрешён только после приёмки обоих. До commit разрешена только явная recovery; после commit восстановление старой DB запрещено. Существующие production rules для provenance, freshness и подтверждённого rollback сохраняются за пределами scoped staging194 исключений.

#### Scenario: ручной запуск, вершина не сдвинулась

- **WHEN** оператор запускает проверенную пару для допущенного source
- **THEN** локальная команда проверяет admission и candidate; hosted workflow не публикует

#### Scenario: новейшая проверенная пара отстала от контента

- **WHEN** production provenance показывает более новое состояние контента
- **THEN** команда отказывает, кроме явно подтверждённого rollback

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

An operator publication command SHALL recheck that its exact SHA remains the admitted canonical head immediately before the atomic switch; a stale run SHALL NOT publish. Serialize publication commands so they cannot race or silently replace a pending candidate. If the source advances after the final check, the selected release remains identifiable by its exact SHA and the site is not automatically changed again. Returning to the new head requires a new explicit local command and successful checks. An older saved release remains available only through the separately confirmed rollback path; its original CI and artifact evidence must remain valid.

#### Scenario: вершина сдвинулась, пока шла сборка

- **WHEN** the admitted SHA is no longer the canonical head at the final pre-switch check
- **THEN** publication refuses before switching

#### Scenario: вершина сдвинулась после последней сверки

- **WHEN** the canonical branch advances during the atomic switch after the last successful check
- **THEN** the served release remains one identified candidate; no automatic follow-up publication occurs

#### Scenario: перезапуск старого прогона

- **WHEN** a successful test run is restarted for a SHA that is no longer the admitted head
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
