/**
 * Генерация конфигурации редиректов для nginx из discovery/url_map.csv.
 *
 * Зачем артефакт, а не «настроим руками при переключении»: карта содержит 768
 * правил, и половина из них — не про красоту URL, а про сохранение трафика.
 * Ручная настройка такого объёма в момент переключения DNS — гарантированные
 * потери, а проверить руками нельзя.
 *
 * Что попадает в конфиг:
 *   - легаси-адреса старого сайта, включая англоязычные алиасы (/contacts);
 *   - варианты со завершающим слэшем: сайт адресует страницы БЕЗ него;
 *   - переехавшие разделы (/promotions → /aktsii-i-skidki);
 *   - плейлисты видео: /video/pleylist/<id> → /video/<id>;
 *   - /sitemap.xml → /sitemap-index.xml (адрес зарегистрирован в вебмастерах).
 *
 * Правила с redirect_type=200 — это адреса, которые обслуживаются напрямую;
 * в конфиг редиректов они не идут.
 *
 * Запуск: из web/ — `npm run redirects:gen`
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP_CSV = join(ROOT, 'discovery', 'url_map.csv');
const OUT = join(ROOT, 'deploy', 'nginx-redirects.conf');

/** Разбор CSV с учётом кавычек: в заголовках страниц есть запятые. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body
    .filter((r) => r.length >= header.length && r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const rows = parseCsv(readFileSync(MAP_CSV, 'utf-8'));

/** Только настоящие перенаправления и только если адрес реально меняется. */
const all301 = rows.filter(
  (r) => r.redirect_type === '301' && r.old_path && r.new_path && r.old_path !== r.new_path,
);

/**
 * Адреса с query-параметром в конфиг НЕ идут: nginx сопоставляет location с
 * путём БЕЗ строки запроса, поэтому `location = /page?section=3` не выберется
 * никогда — правило выглядело рабочим, но не делало ничего.
 *
 * Для таких адресов редирект и не нужен: параметр надо ПОДДЕРЖАТЬ на странице
 * (открыть нужный раздел и прокрутить к нему), а не срезать. Перенаправление со
 * срезанным параметром сломало бы глубокую ссылку, которой футер старого сайта
 * ведёт на «Документы».
 */
const withQuery = all301.filter((r) => r.old_path.includes('?'));
const redirects = all301.filter((r) => !r.old_path.includes('?'));

// Дубликаты по старому адресу: nginx возьмёт первое совпадение, а разные цели у
// одного адреса — это ошибка карты, а не выбор.
const seen = new Map<string, string>();
const conflicts: string[] = [];
for (const r of redirects) {
  const prev = seen.get(r.old_path);
  if (prev && prev !== r.new_path) conflicts.push(`${r.old_path} → ${prev} и → ${r.new_path}`);
  else seen.set(r.old_path, r.new_path);
}

const lines = [
  '# Редиректы легаси-адресов старого сайта.',
  '#',
  '# СГЕНЕРИРОВАНО: web/scripts/gen-redirects.ts из discovery/url_map.csv.',
  '# Править руками не нужно — правьте карту и перегенерируйте.',
  '#',
  '# Подключение в server-блоке:  include /etc/nginx/ikpk-redirects.conf;',
  '#',
  '# Важно про порядок try_files в основном конфиге: $uri/index.html должен идти',
  '# ПЕРЕД $uri/, иначе nginx сам отвечает 301 на вариант со завершающим слэшем,',
  '# и адреса разойдутся с каноническими.',
  '',
  'location = /sitemap.xml { return 301 /sitemap-index.xml; }',
  '',
  ...(withQuery.length
    ? [
        '# Адреса с query-параметром здесь СОЗНАТЕЛЬНО отсутствуют: nginx',
        '# сопоставляет location без строки запроса. Их нужно поддерживать на',
        '# самой странице, а не перенаправлять со срезанным параметром:',
        ...withQuery.map((r) => `#   ${r.old_path}  (ожидается поддержка в странице)`),
        '',
      ]
    : []),
  '# Точные совпадения: адрес → адрес',
  ...[...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([from]) => from !== '/sitemap.xml')
    .map(([from, to]) => `location = ${from} { return 301 ${to}; }`),
];

// Конфликт в карте — ошибка данных, а не примечание к выводу. Прежде генератор
// выбирал первую цель, писал конфиг и печатал конфликты уже ПОСЛЕ записи с кодом
// выхода 0: неверная карта уезжала в production молча. Проверяем до записи, чтобы
// на диске не остался конфиг, собранный по произвольному выбору.
if (conflicts.length) {
  console.error(`КОНФЛИКТЫ (один адрес, разные цели) — ${conflicts.length}:`);
  for (const c of conflicts) console.error(`  ${c}`);
  console.error('\nКонфиг НЕ записан: карту адресов нужно исправить.');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf-8');
renameSync(tmp, OUT);

console.log(`правил в карте: ${rows.length}, перенаправлений: ${redirects.length}`);
if (withQuery.length) {
  console.log(
    `с query-параметром (в конфиг не идут, нужна поддержка в странице): ${withQuery.length}` +
      ` → ${withQuery.map((r) => r.old_path).join(', ')}`,
  );
}
console.log(`уникальных адресов: ${seen.size}`);
console.log(`\nзаписан ${OUT.replace(ROOT, '.')}`);
