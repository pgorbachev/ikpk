#!/usr/bin/env node
// Извлечение значений атрибутов из собранных HTML-файлов РАЗБОРОМ РАЗМЕТКИ, а не
// регуляркой по имени атрибута.
//
// Вызывается из `form_links_match_mode` (scripts/lib/deploy-checks.sh). Спека требует
// различать ссылку формы заявки и адрес загрузчика виджета по НАЗНАЧЕНИЮ — элементом,
// его атрибутом и соседом-атрибутом на том же теге (openspec/changes/external-widgets/
// specs/external-widgets/spec.md:1020), а не по имени атрибута: имя `data-form-link` не
// оканчивается на href/src/action и терялось прежним построчным извлечением, а имя
// `data-chat-src` совпадало с ним и ловило загрузчик чата как ссылку формы.
//
// Признак назначения: элемент, несущий CHAT_FACADE_ATTR, размечает ВСЁ своё поддерево как
// носитель встраивания стороннего виджета — ни один атрибут внутри него не может быть
// ссылкой формы, независимо от имени атрибута и от того, на каком именно узле поддерева он
// стоит. Это не то же самое, что «только собственные атрибуты корня»: реальная разметка
// (`web/src/components/chat/ChatFacade.astro`) кладёт `data-chat-loader-src` на вложенную
// `<button>`, а не на сам `<div data-chat-facade>` — при исключении только корня адрес
// загрузчика остаётся кандидатом и сравнивается с ожиданием режима как если бы это была
// ссылка формы. Остальные значения возвращаются как есть: отбор по назначению (портал
// Bitrix24 / заглушка / crm_form) и сверка с ожиданием режима остаются в bash — здесь
// только извлечение и нормализация значения (trim, тот же приём, что раньше делал sed),
// деление труда не меняется.
//
// Использует parse5 из web/node_modules: деплой уже требует `npm --prefix web ci` перед
// вызовом этой функции (scripts/deploy-web.sh), поэтому пакет гарантированно установлен
// к моменту вызова.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHAT_FACADE_ATTR = 'data-chat-facade';

const [, , distDir] = process.argv;
if (!distDir) {
  console.error('usage: form-link-candidates.mjs <dist-dir>');
  process.exit(2);
}

let stat;
try {
  stat = statSync(distDir);
} catch (err) {
  console.error(`каталог сборки недоступен: ${distDir} (${err.message})`);
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(`не каталог: ${distDir}`);
  process.exit(2);
}

const repoRoot = new URL('../../', import.meta.url);
const parse5Url = new URL('web/node_modules/parse5/dist/index.js', repoRoot);
let parse;
try {
  ({ parse } = await import(parse5Url.href));
} catch (err) {
  console.error(`не удалось загрузить parse5 из ${parse5Url.href}: ${err.message}`);
  process.exit(2);
}

function listHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHtmlFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) out.push(full);
  }
  return out;
}

// Содержимое <template> лежит в отдельном фрагменте (как в web/tests/helpers/dom.ts):
// без него обход слепнет ровно там, где разметка спрятана (каталог статей).
function children(node) {
  return [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])];
}

function* walk(node) {
  for (const child of children(node)) {
    if ('tagName' in child) {
      // Поддерево фасада не yield'ится вовсе — ни сам узел, ни его потомки: иначе адрес
      // загрузчика на вложенной кнопке остаётся кандидатом (см. комментарий у CHAT_FACADE_ATTR).
      if (child.attrs.some((a) => a.name === CHAT_FACADE_ATTR)) continue;
      yield child;
      yield* walk(child);
    }
  }
}

let files;
try {
  files = listHtmlFiles(distDir);
} catch (err) {
  console.error(`не удалось прочитать ${distDir}: ${err.message}`);
  process.exit(2);
}

const values = [];
for (const file of files) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`не удалось прочитать ${file}: ${err.message}`);
    process.exit(2);
  }
  const doc = parse(html);
  for (const el of walk(doc)) {
    for (const a of el.attrs) {
      const value = a.value.trim();
      if (value !== '') values.push(value);
    }
  }
}

process.stdout.write(values.length ? values.join('\n') + '\n' : '');
