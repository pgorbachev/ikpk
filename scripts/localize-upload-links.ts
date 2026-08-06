/**
 * Локализация ссылок на upload-API старого сайта в файлах discovery/entities.
 *
 * `https://ikpk.su/api/upload/file/<uuid>` — эндпоинт умирающего бэкенда: он
 * исчезнет вместе со старым сайтом при переключении DNS. Ссылки надо заменить
 * на локальные `/media/uploads/<uuid>.<ext>`, а файлы скачать
 * (scripts/download-media.ts качает всё, что найдёт локальными путями).
 *
 * Почему отдельный шаг, а не хардкод расширения: в URL API расширения нет, и
 * первый заход по этому источнику предполагал, что там всегда картинки
 * (`.webp`). Оказалось не так — восстановленный контент свёрнутых секций
 * (см. recover-collapsibles.mjs) ссылается на 56 PDF: учебные схемы,
 * программы, документы. Расширение поэтому берём из content-type, спрашивая
 * сервер, а не угадывая. Ответы кешируются в web/src/lib/upload-types.json,
 * чтобы повторные прогоны не ходили в сеть.
 *
 * Запуск:  npx tsx scripts/localize-upload-links.ts [файл…]
 * Без аргументов обходит все discovery/entities/*.json.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTITIES_DIR = join(ROOT, 'discovery', 'entities');
const TYPES_CACHE = join(ROOT, 'web', 'src', 'lib', 'upload-types.json');

const UPLOAD_API_PREFIX = 'https://ikpk.su/api/upload/file/';
const UPLOAD_API_RE = /https:\/\/ikpk\.su\/api\/upload\/file\/([a-f0-9-]{36})/g;

/** content-type → расширение. Всё неизвестное считаем ошибкой, а не картинкой. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

const cache: Record<string, string> = existsSync(TYPES_CACHE)
  ? JSON.parse(readFileSync(TYPES_CACHE, 'utf-8'))
  : {};

/** Спрашивает у сервера тип файла. HEAD, чтобы не тянуть тело. */
async function probeExt(uuid: string): Promise<string | null> {
  if (cache[uuid]) return cache[uuid];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(UPLOAD_API_PREFIX + uuid, { method: 'HEAD' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const ext = EXT_BY_TYPE[type];
      if (!ext) {
        console.warn(`  ! ${uuid}: неизвестный content-type «${type}» — пропускаю`);
        return null;
      }
      cache[uuid] = ext;
      return ext;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`  ! ${uuid}: не удалось определить тип (${(err as Error).message})`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return null;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : readdirSync(ENTITIES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(ENTITIES_DIR, f));

// Сначала собираем все uuid по всем файлам, потом опрашиваем сервер — так
// один и тот же файл не запрашивается дважды.
const uuids = new Set<string>();
for (const file of targets) {
  const raw = readFileSync(file, 'utf-8');
  for (const m of raw.matchAll(UPLOAD_API_RE)) uuids.add(m[1]);
}

const unknown = [...uuids].filter((u) => !cache[u]);
console.log(`ссылок на upload-API: ${uuids.size} уникальных, тип неизвестен у ${unknown.length}`);

const CONCURRENCY = 6;
const queue = [...unknown];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const uuid = queue.shift();
      if (!uuid) break;
      await probeExt(uuid);
    }
  }),
);

writeFileSync(TYPES_CACHE, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');

const byExt: Record<string, number> = {};
for (const u of uuids) if (cache[u]) byExt[cache[u]] = (byExt[cache[u]] ?? 0) + 1;
console.log('типы:', Object.entries(byExt).map(([e, n]) => `${e}:${n}`).join(', ') || '—');

let changedFiles = 0;
let replaced = 0;
let skipped = 0;

for (const file of targets) {
  const raw = readFileSync(file, 'utf-8');
  const next = raw.replace(UPLOAD_API_RE, (whole, uuid: string) => {
    const ext = cache[uuid];
    if (!ext) {
      skipped++;
      return whole; // тип неизвестен — ссылку не трогаем, иначе получим битый путь
    }
    replaced++;
    return `/media/uploads/${uuid}.${ext}`;
  });

  if (next !== raw) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, file);
    changedFiles++;
  }
}

console.log(`заменено ссылок: ${replaced}, файлов изменено: ${changedFiles}`);
if (skipped) console.log(`оставлено как было (тип не определён): ${skipped}`);

// Оставленные ссылки — это адреса, живущие только пока жив старый сайт: после
// переключения DNS они умрут. Прежде скрипт сообщал их число и завершался нулём,
// то есть миграция выглядела успешной с недомигрированным контентом.
if (skipped > 0 && !process.argv.includes('--allow-unresolved')) {
  console.error(
    `\nне локализовано ссылок: ${skipped} — они перестанут работать после` +
      `\nпереключения DNS. Осознанный обход: --allow-unresolved`,
  );
  process.exit(1);
}
console.log('дальше: npx tsx ../scripts/download-media.ts из web/');
