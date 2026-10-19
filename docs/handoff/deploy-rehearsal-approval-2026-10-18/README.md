# Согласованный план репетиции CMS и static deployment

Владелец разрешил применить этот план после положительного заключения Opus. Заключение относилось к плану и не является review реализации. Точный v6 delta применён к активному change; кодовые заготовки сохранены без правок, production-команды не выполнялись.

## Три сценария приёмки

1. **Первая репетиция на demo193:** один допущенный full source SHA и успешный canonical push `Tests` со всеми обязательными jobs. CMS и static payloads построены из этого SHA; локальные проверки и off-host browser checks читают те же запечатанные static bytes. Оператор закрывает и проверяет CMS writers, снимает проверенные DB/media bytes вне сервера, выполняет миграцию непривилегированно, подтверждает CMS и фактически отдаваемый static release, затем фиксирует обе части до снятия fence.
2. **Сбой до общего commit:** команда останавливается в fenced состоянии; восстановление выполняется явной командой. После durable commit старую базу восстанавливать нельзя. Прерванное получение операции не даёт менять данные или код; recovery сначала закрывает writers.
3. **Второй выпуск после правки редактора:** новая запись и media, созданные после первой репетиции, остаются в следующем опубликованном снимке; миграция повторно не запускается.

Patch защищает exact source/CI admission, отсутствие hosted deploy credentials, единственный operator production path, проверку целевой раздачи до отключения прежнего пути, off-host backup bytes, проверку фактической пары, durable fence/commit и запрет DB restore после commit. Demo193 сохраняет согласованное исключение frozen capture без ослабления production provenance/high-watermark правил.

Главный операционный риск — длительная пауза записи редакторов: writer fence остаётся закрытым на время CMS migration/health polling до 20 минут и проверки static serving. Это должно быть явно принято до live rehearsal.

Перед любым запуском на 193 нужны свежий canonical CI run для curated candidate SHA со всеми обязательными jobs успешными и два независимых code reviews. Demo193 rehearsal не является production acceptance. Production остаётся отдельным этапом: curated tree должен попасть в `main` через squash; новый exact main SHA требует собственного canonical `Tests` run, а GitHub Release создаётся только после успешного production deployment.

## Проверка плана

- Strict OpenSpec validation: passed.
- Applicability: exact v6 patch applied and archived in a disposable copy; both automatic publication requirements were removed, and the checked-content and single-operator-path contracts remain effective.
- Current change tasks: 0/6 complete. None is evidence of live rehearsal.
- Production, release, tag, and `dev` retirement are outside this approval.
