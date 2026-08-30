# Tiptap + Strapi: proof of concept

Статус: изолированный PoC на ветке `feat/cms-tiptap-editor`. Это не миграция рабочих полей и не
закрытие задачи 3.10 change `cms-content-authoring-and-migration`.

## Что проверяет PoC

- Strapi 5.51.2 загружает собственное поле `global::tiptap-html`;
- Tiptap загружается из npm-сборки админки, без внешнего CDN;
- запись «Прототип редактора» хранит тело как `text` (HTML) в SQLite;
- редактор отдаёт HTML через `editor.getHTML()` и создаёт таблицу 3×3 с заголовками.

В панели Strapi тип называется «Прототип редактора». Создайте запись, нажмите «Вставить
таблицу», заполните ячейки и сохраните черновик. В базе поле `body` будет содержать HTML с
`<table>`, а не JSON редактора.

## Как запустить локально

Из `cms/`:

```sh
APP_KEYS='four,random,keys,here' \
API_TOKEN_SALT='random-secret' \
ADMIN_JWT_SECRET='random-secret' \
TRANSFER_TOKEN_SALT='random-secret' \
ENCRYPTION_KEY='random-secret' \
DATABASE_FILENAME='.tmp/tiptap-poc.db' \
PORT=1339 npm run develop
```

Открыть `http://localhost:1339/admin`. Первого администратора Strapi попросит создать именно в
отдельной базе `.tmp/tiptap-poc.db`; рабочая база `.tmp/data.db` в этот режим не вовлечена.

## Граница PoC

PoC не добавляет свою санитизацию и не является разрешением публиковать HTML напрямую. Основная
реализация должна провести HTML из CMS через уже принятую центральную границу
`rich-content-safety`: черновик с неподходящей разметкой сохраняется с предупреждением, а её
публикация отклоняется. Также до основной реализации нужны редакторские роли, миграция настоящих
полей и проверка разметки Tiptap против нормативного allowlist.
