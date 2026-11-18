## Why

Редактору приходится управлять HTML и повторять сведения о каждом проведении. Старые страницы смешивают учебное содержание с оболочкой и элементами расписания; несогласованные цена и бесплатность мешают надёжно публиковать данные.

## What Changes

- Содержательные разделы семинара хранятся отдельно от визуального оформления; сайт единообразно оформляет семантический текст, списки и ссылки по согласованному примеру.
- **BREAKING** Продолжительность по умолчанию хранится в семинаре, проведение может переопределить её; оба поля могут оставаться пустыми. При пустом эффективном значении все публичные места сайта показывают «Продолжительность не задана», не записывая текст в данные и не вычисляя часы по датам. Пустая продолжительность больше не требует исключения или блокирует CMS-публикацию. Цена остаётся у проведения: пустая цена платного проведения означает «Цена уточняется»; ноль при признаке «платно» остаётся противоречием, бесплатному проведению соответствует ноль.
- **BREAKING** Онлайн — отдельный признак; для офлайна нужен город. Преподаватели нового проведения выбираются из списка семинара, существующие назначения сохраняются.
- Создание проведения из семинара заполняет и фиксирует связь; после первого сохранения смена семинара запрещена. Возврат из проведения ведёт в семинар.
- Без согласованного mapping пустая duration сохраняет точное исходное представление: `""` остаётся пустой строкой, SQL NULL остаётся NULL; смешивать их нельзя. Отдельно согласованный per-row mapping может заполнить пустой seminar default подтверждённым значением и очистить дублирующий непустой override только если effective duration каждого проведения сохраняется. Mapping фиксирует исходные/целевые ячейки и основание для каждого значения; угадывать длительность или выводить её из дат нельзя. Пустая duration не создаёт исключений. Неоднозначное непустое значение не выбирается по датам или соседней записи. Исключения и редакторские решения остаются для цены и других активных правил. Доверенные `missing-duration` элементы старого sealed registry остаются инертными метаданными без rebind или изменения hash; новые реестры их не создают.
- SQLite backup/restore сохраняет исходный database lineage ID. Репетиция staging194 образует отдельные environment/cohort/operation/source-snapshot/proof/receipt identities и требует повторной admission по точной migration history; она не наследует автоматически staging receipts, plan или registry только по совпадению lineage ID. Успех staging не доказывает выполнение production migration.

## Capabilities

### New Capabilities

- `seminar-content-and-occurrence-model`: структура и представление семинаров, форма проведения, ограничения и безопасная миграция.

### Modified Capabilities

- `cms-content-source`: проверка снимка допускает NULL duration без исключения, сохраняя активные проверки цены, связей, обязательных полей и доверенных исключений.

Пересечение с незавершёнными `seminar-management-ux` и `cms-content-authoring-and-migration` разрешается явно до реализации и архивирования; этот change не отменяет их остальные требования.

## Impact

CMS Strapi and its editors/publication guards; duration inheritance across published seminar/event versions; snapshot validation and historical-exception registry generation; all Astro public duration displays; SQLite rehearsal and source/receipt/registry lineage. No database schema or row rewrite is required for NULL duration. Staging and production retain distinct environment/cohort/operation/snapshot/proof/receipt identities; a SQLite copy does not silently change the database lineage ID. URLs, registration links, documents and media remain unchanged; price and non-duration guards remain active.
