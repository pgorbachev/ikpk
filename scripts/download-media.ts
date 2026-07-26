/**
 * Этап 2 (план 004): миграция медиа со storage.yandexcloud.net.
 *
 * Собирает все URL бакета из discovery/entities/*.json и web/src/**, скачивает
 * файлы в web/public/** (путь после /ikpk-image/ сохраняется 1:1, поэтому
 * рерайт URL — простая замена префикса) и генерирует манифест размеров
 * web/src/lib/media-manifest.json для проставления width/height у <img>
 * (защита от CLS).
 *
 * Канонизация путей: ключи манифеста и пути на диске хранятся ДЕКОДИРОВАННЫМИ
 * (кириллица как есть); percent-encoding применяется только при fetch.
 *
 * Идемпотентен: уже скачанные файлы пропускаются (--force для перекачки);
 * запись через tmp+rename — обрыв не оставляет усечённый файл под финальным
 * именем.
 *
 * Usage: npx tsx download-media.ts [--force]
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const ENTITIES_DIR = join(ROOT, 'discovery', 'entities');
const PUBLIC_DIR = join(ROOT, 'web', 'public');
const MANIFEST_PATH = join(ROOT, 'web', 'src', 'lib', 'media-manifest.json');

// Тот же префикс продублирован в web/src/lib/media.ts (BUCKET_PREFIX) —
// разные npm-пакеты; при изменении бакета править ОБА места.
const BUCKET_PREFIX = 'https://storage.yandexcloud.net/ikpk-image';
const URL_RE = /https:\/\/storage\.yandexcloud\.net\/ikpk-image(\/[^"'\\\s)<>]+)/g;
const LOCAL_RE = /["'`(](\/(?:media|terms)\/[^"'`\\\s)<>]+\.(?:webp|jpe?g|png|gif|svg|pdf))/g;

/**
 * Контентные изображения старой CMS бывают сильно оверсайз (до 2591px при
 * отображении ≤800px) — это валит LCP-бюджет ≤2.5s на мобильном троттлинге.
 * Всё шире MAX_WIDTH даунскейлится при скачивании В ИСХОДНОМ ФОРМАТЕ
 * (расширение файла остаётся честным). Оригиналы остаются в бакете.
 */
const MAX_WIDTH = 1200;
const QUALITY = 80;

/**
 * Ассеты СТАРОЙ Next.js-сборки: эмблемы трёх институтов (главная) и иконки
 * министерств (/svedeniya-ob-obrazovatelnoy-organizatsii). Лежали на
 * ikpk.su/_next/static/media/** — то есть на умирающем деплое: при переключении
 * DNS этот путь исчезает вместе со старым сайтом, и логотипы на главной
 * отвалились бы разом. Захвачены локально; ссылки в discovery/entities
 * переписаны на /media/legacy/**. Ключ — локальный путь, значение — источник
 * (сохранён для провенанса; хеш в имени файла не переносим).
 */
const LEGACY_NEXT_ASSETS: Record<string, string> = {
  '/media/legacy/logo-v2.png': 'https://ikpk.su/_next/static/media/logo-v2.68e2bc89.png',
  '/media/legacy/logo-upledger-inst.png':
    'https://ikpk.su/_next/static/media/logo-upledger-inst.8710042f.png',
  '/media/legacy/logo-barral-inst.png':
    'https://ikpk.su/_next/static/media/logo-barral-inst.3978004d.png',
  '/media/legacy/educationMinistryIcon.png':
    'https://ikpk.su/_next/static/media/educationMinistryIcon.cf7143fa.png',
  '/media/legacy/scienceEducationMinistryIcon.png':
    'https://ikpk.su/_next/static/media/scienceEducationMinistryIcon.4180b187.png',
};

/**
 * Третий источник картинок старого сайта: его собственный API
 * `https://ikpk.su/api/upload/file/<uuid>` (без расширения, отдаёт image/webp).
 * Это эндпоинт умирающего бэкенда: при переключении DNS он исчезает вместе
 * со старым сайтом, а на него смотрят изображения в статьях, группах курсов
 * и на страницах институтов. Локально раскладываем как
 * /media/uploads/<uuid>.webp.
 */
const UPLOAD_API_PREFIX = 'https://ikpk.su/api/upload/file/';
const UPLOAD_API_RE = /https:\/\/ikpk\.su\/api\/upload\/file\/([a-f0-9-]{36})/g;
const UPLOAD_LOCAL_PREFIX = '/media/uploads/';

function uploadLocalPath(uuid: string): string {
  return `${UPLOAD_LOCAL_PREFIX}${uuid}.webp`;
}

/**
 * Тип файла по сигнатуре первых байтов. Нужен там, где сервер не выставил
 * content-type: заголовок `application/octet-stream` не говорит ничего, а
 * подменённое расширение надо поймать (упаковать PDF под именем .webp нельзя —
 * sharp потом тихо упадёт на метаданных).
 */
function sniffType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const hex = buf.subarray(0, 4).toString('hex').toUpperCase();
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (hex.startsWith('FFD8FF')) return 'image/jpeg';
  if (hex === '89504E47') return 'image/png';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  const head = buf.subarray(0, 256).toString('utf-8');
  if (head.includes('<svg') || head.includes('<?xml')) return 'image/svg+xml';
  return null;
}

/** Откуда качать данный локальный путь: легаси-деплой, upload-API или бакет. */
function sourceUrlFor(path: string): string {
  const legacy = LEGACY_NEXT_ASSETS[path];
  if (legacy) return legacy;
  if (path.startsWith(UPLOAD_LOCAL_PREFIX)) {
    // расширение локальное (по content-type), в URL API его нет — срезаем любое
    const uuid = path.slice(UPLOAD_LOCAL_PREFIX.length).replace(/\.[a-z0-9]+$/i, '');
    return UPLOAD_API_PREFIX + uuid;
  }
  return BUCKET_PREFIX + encodeURI(path);
}

const force = process.argv.includes('--force');

// ---------- collect unique bucket paths ----------
// Источники: discovery/entities/*.json + web/src/** (там есть supplement-файлы
// с прямыми ссылками). Ищем и полные URL бакета, и уже локализованные
// локальные пути — так скрипт остаётся полным после рерайта ссылок в src.

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.(ts|astro|json)$/.test(entry.name) && !entry.name.includes('media-manifest'))
      yield full;
  }
}

/** decodeURI с guard: битая %-последовательность не должна ронять весь прогон. */
function safeDecode(path: string): string | null {
  try {
    return decodeURI(path);
  } catch {
    console.warn(`  ! skipping malformed percent-encoding: ${path}`);
    return null;
  }
}

const paths = new Set<string>();
const sources = [
  ...readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(ENTITIES_DIR, f)),
  ...walkSourceFiles(join(ROOT, 'web', 'src')),
];
for (const file of sources) {
  const raw = readFileSync(file, 'utf-8');
  for (const match of raw.matchAll(URL_RE)) {
    // отбрасываем пути без расширения (константы-базы вроде .../images)
    if (!/\.[a-z0-9]+$/i.test(match[1])) continue;
    const decoded = safeDecode(match[1]);
    if (decoded) paths.add(decoded);
  }
  for (const match of raw.matchAll(LOCAL_RE)) {
    const decoded = safeDecode(match[1]);
    if (decoded) paths.add(decoded);
  }
  // картинки из upload-API старого сайта
  for (const match of raw.matchAll(UPLOAD_API_RE)) paths.add(uploadLocalPath(match[1]));
}
// Легаси-ассеты добавляем всегда: после рерайта ссылок они уже не находятся
// как внешние URL, а без них главная теряет эмблемы институтов.
for (const path of Object.keys(LEGACY_NEXT_ASSETS)) paths.add(path);

console.log(`Found ${paths.size} unique assets (bucket + legacy Next.js)`);

// ---------- download ----------

interface ManifestEntry {
  width?: number;
  height?: number;
}
const manifest: Record<string, ManifestEntry> = {};

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const path of [...paths].sort()) {
  const url = sourceUrlFor(path);
  const localPath = join(PUBLIC_DIR, ...path.split('/').filter(Boolean));

  if (!force && existsSync(localPath) && statSync(localPath).size > 0) {
    skipped++;
  } else {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buf = Buffer.from(await res.arrayBuffer());
      let resized = '';
      const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();

      // upload-API старого сайта отдаёт под одинаковыми URL и картинки, и PDF.
      // Расширение в ссылке должно совпадать с реальным типом, иначе на прод
      // уедет PDF под именем .webp (и sharp тихо упадёт на метаданных).
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const expected: Record<string, string> = {
        webp: 'image/webp',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
      };
      // Часть файлов бакет отдаёт как application/octet-stream — тип там просто
      // не выставлен, и это НЕ значит, что содержимое не то. Заголовку в таком
      // случае верить нечему, поэтому смотрим на сигнатуру байтов.
      const INCONCLUSIVE = ['', 'application/octet-stream', 'binary/octet-stream'];
      const actual = INCONCLUSIVE.includes(contentType)
        ? sniffType(buf)
        : contentType;

      // Бакет старого сайта хранит часть файлов как JPEG/PNG под именем .webp.
      // Ссылки в данных ведут на .webp, переименование потребовало бы правки
      // всех ссылок — поэтому приводим СОДЕРЖИМОЕ к расширению: перекодируем
      // в настоящий webp. Имя остаётся честным, размер обычно падает.
      let transcoded = '';
      if (ext === 'webp' && (actual === 'image/jpeg' || actual === 'image/png')) {
        const before = buf.length;
        buf = await sharp(buf).webp({ quality: QUALITY }).toBuffer();
        transcoded = ` [transcoded ${actual.replace('image/', '')}→webp ${Math.round(before / 1024)}KB→${Math.round(buf.length / 1024)}KB]`;
      } else if (ext && expected[ext] && actual && actual !== expected[ext]) {
        throw new Error(
          `тип не совпадает с расширением: ссылка обещает .${ext} (${expected[ext]}), ` +
            `фактически ${actual}` +
            (INCONCLUSIVE.includes(contentType) ? ' (по сигнатуре файла)' : ' (по content-type)') +
            ' — поправьте расширение в ссылке'
        );
      }

      if (ext && ['webp', 'jpg', 'jpeg', 'png'].includes(ext)) {
        const meta = await sharp(buf).metadata();
        const tooWide = (meta.width ?? 0) > MAX_WIDTH;

        // Даунскейл оверсайза + пережатие раздутых файлов. Второе не менее
        // важно: upload-API старого сайта отдаёт webp практически без сжатия
        // (до 2.8 МБ на 974×1349 ≈ 2 байта на пиксель), и такие картинки
        // уезжают посетителю как есть. Кодируем в ИСХОДНЫЙ формат, чтобы
        // расширение оставалось честным, и оставляем результат ТОЛЬКО если он
        // меньше оригинала — уже оптимизированные файлы не портим.
        if (tooWide || ['webp', 'jpg', 'jpeg'].includes(ext)) {
          const pipeline = sharp(buf);
          if (tooWide) pipeline.resize({ width: MAX_WIDTH });
          if (ext === 'webp') pipeline.webp({ quality: QUALITY });
          else if (ext === 'png') pipeline.png();
          else pipeline.jpeg({ quality: QUALITY });

          const candidate = Buffer.from(await pipeline.toBuffer());
          const gain = buf.length - candidate.length;
          if (tooWide || gain > 0) {
            const from = `${(buf.length / 1024).toFixed(0)}KB`;
            buf = candidate;
            resized =
              (tooWide ? ` [resized ${meta.width}→${MAX_WIDTH}px]` : '') +
              (gain > 0 ? ` [recompressed ${from}→${(buf.length / 1024).toFixed(0)}KB]` : '');
          }
        }
      }
      mkdirSync(dirname(localPath), { recursive: true });
      // tmp + rename: обрыв записи не оставляет усечённый файл под финальным именем
      const tmpPath = localPath + '.tmp-download';
      writeFileSync(tmpPath, buf);
      renameSync(tmpPath, localPath);
      downloaded++;
      console.log(`  ✓ ${path} (${(buf.length / 1024).toFixed(0)} KB)${transcoded}${resized}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${path}: ${(err as Error).message}`);
      continue;
    }
  }

  const entry: ManifestEntry = {};
  if (!path.endsWith('.pdf') && !path.endsWith('.svg')) {
    try {
      const dim = await sharp(readFileSync(localPath)).metadata();
      entry.width = dim.width;
      entry.height = dim.height;
    } catch {
      console.warn(`  ? no dimensions for ${path}`);
    }
  }
  manifest[path] = entry;
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `\nDone: ${downloaded} downloaded, ${skipped} already present, ${failed} FAILED.` +
    `\nManifest: ${MANIFEST_PATH} (${Object.keys(manifest).length} entries)`
);
if (failed > 0) process.exit(1);
