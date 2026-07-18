/**
 * Этап 2 (план 004): миграция медиа со storage.yandexcloud.net.
 *
 * Собирает все URL бакета из discovery/entities/*.json, скачивает файлы в
 * web/public/media/** (путь после /ikpk-image/ сохраняется 1:1, поэтому
 * рерайт URL — простая замена префикса) и генерирует манифест размеров
 * web/src/lib/media-manifest.json для проставления width/height у <img>
 * (защита от CLS).
 *
 * Идемпотентен: уже скачанные файлы пропускаются (--force для перекачки).
 *
 * Usage: npx tsx download-media.ts [--force]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { imageSize } from 'image-size';
import sharp from 'sharp';

/**
 * Контентные изображения старой CMS бывают сильно оверсайз (до 2591px при
 * отображении ≤800px) — это валит LCP-бюджет ≤2.5s на мобильном троттлинге.
 * Всё шире MAX_WIDTH даунскейлится при скачивании; URL и разметка не меняются.
 * Оригиналы остаются в бакете старого сайта.
 */
const MAX_WIDTH = 1200;
const WEBP_QUALITY = 80;

const ROOT = join(import.meta.dirname, '..');
const ENTITIES_DIR = join(ROOT, 'discovery', 'entities');
// Файлы кладутся в public/ по пути бакета 1:1 (обычно /media/**, но есть и
// /terms/** с PDF) — тогда рерайт URL = чистая замена префикса на ''.
const PUBLIC_DIR = join(ROOT, 'web', 'public');
const MANIFEST_PATH = join(ROOT, 'web', 'src', 'lib', 'media-manifest.json');

const BUCKET_PREFIX = 'https://storage.yandexcloud.net/ikpk-image';
const URL_RE = /https:\/\/storage\.yandexcloud\.net\/ikpk-image(\/[^"'\\\s)<>]+)/g;

const force = process.argv.includes('--force');

// ---------- collect unique bucket paths ----------
// Источники: discovery/entities/*.json + web/src/** (там есть supplement-файлы
// с прямыми ссылками). Ищем и полные URL бакета, и уже локализованные
// /media/**-пути — так скрипт остаётся полным после рерайта ссылок в src.

const LOCAL_RE = /["'`(](\/media\/[^"'`\\\s)<>]+\.(?:webp|jpe?g|png|gif|svg|pdf))/g;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.(ts|astro|json)$/.test(name.name) && !name.name.includes('media-manifest'))
      yield full;
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
  for (const match of raw.matchAll(URL_RE)) paths.add(decodeURI(match[1]));
  for (const match of raw.matchAll(LOCAL_RE)) paths.add(decodeURI(match[1]));
}
// Отбросить пути без расширения (например, константы-базы вроде .../images)
for (const p of paths) if (!/\.[a-z0-9]+$/i.test(p)) paths.delete(p);
console.log(`Found ${paths.size} unique bucket assets`);

// ---------- download ----------

interface ManifestEntry {
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
}
const manifest: Record<string, ManifestEntry> = {};

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const path of [...paths].sort()) {
  const url = BUCKET_PREFIX + encodeURI(path);
  const localPath = join(PUBLIC_DIR, ...path.split('/').filter(Boolean));

  if (!force && existsSync(localPath) && statSync(localPath).size > 0) {
    skipped++;
  } else {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buf = Buffer.from(await res.arrayBuffer());
      let resized = '';
      if (/\.(webp|jpe?g|png)$/i.test(path)) {
        const meta = await sharp(buf).metadata();
        if ((meta.width ?? 0) > MAX_WIDTH) {
          buf = Buffer.from(
            await sharp(buf).resize({ width: MAX_WIDTH }).webp({ quality: WEBP_QUALITY }).toBuffer()
          );
          resized = ` [resized ${meta.width}→${MAX_WIDTH}px]`;
        }
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, buf);
      downloaded++;
      console.log(`  ✓ ${path} (${(buf.length / 1024).toFixed(0)} KB)${resized}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${path}: ${(err as Error).message}`);
      continue;
    }
  }

  const buf = readFileSync(localPath);
  const entry: ManifestEntry = {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
  };
  if (!path.endsWith('.pdf')) {
    try {
      const dim = imageSize(buf);
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
