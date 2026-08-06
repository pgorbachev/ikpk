import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// Манифест кормит подстановку width/height у <img> — то есть защиту от сдвига
// макета. Пересборка манифеста из результатов загрузки молча теряла записи,
// если запрос к источнику упал: файл на месте, размеров у него больше нет. Так
// пропали 6 обложек видео — они приходят не из бакета, а с видеохостинга, и их
// адрес в бакете отдаёт 404.
//
// Источник списка файлов — media-originals/, а НЕ web/public/media/. Отдаваемые
// версии генерируются скриптом make-derivatives.ts на prebuild и лежат в
// .gitignore, поэтому в чистом окружении их не существует: проверка по
// public/media падала в CI с ENOENT на каждом прогоне (job «Unit and build
// tests» выполняет `npm test` до всякой сборки). Оригиналы же хранятся в git и
// есть всегда — они и есть источник правды, из которого манифест обязан быть
// собран.
//
// Отображение оригинал → отдаваемый файл в make-derivatives.ts однозначное:
// `out = join(SHIPPED, rel)`, имя и расширение сохраняются. Поэтому ключ
// манифеста вычисляется из пути оригинала напрямую, без запуска генератора.
// Такая проверка не слабее прежней, а сильнее: прежняя видела только файлы,
// которые генератор успел создать, и молчала о том, что он уронил целиком.
const ORIGINALS_DIR = join(import.meta.dirname, '..', '..', 'media-originals');
const MANIFEST_PATH = join(import.meta.dirname, '..', 'src', 'lib', 'media-manifest.json');
// Растровые форматы — те, у которых манифест обязан знать геометрию. PDF и SVG
// переносятся как есть и получают пустую запись по замыслу.
const RASTER = /\.(webp|jpe?g|png|gif)$/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Ключ манифеста для оригинала: путь отдаваемой версии от корня сайта. */
const shippedKey = (file: string): string =>
  `/media/${relative(ORIGINALS_DIR, file).split(/[\\/]/).join('/')}`;

describe('media manifest', () => {
  // Отсутствие материала для проверки — это «не выполнено», а не «дефектов
  // нет»: без этого гейта пустой каталог оригиналов давал бы зелёный прогон.
  it('материал для проверки на месте', () => {
    expect(existsSync(ORIGINALS_DIR), `нет каталога оригиналов: ${ORIGINALS_DIR}`).toBe(true);
    const raster = [...walk(ORIGINALS_DIR)].filter((f) => RASTER.test(f));
    expect(raster.length, 'растровых оригиналов ноль — проверять нечего').toBeGreaterThan(0);
  });

  it('covers every raster original with width and height', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Record<
      string,
      { width?: number; height?: number }
    >;

    const missing: string[] = [];
    for (const file of walk(ORIGINALS_DIR)) {
      if (!RASTER.test(file)) continue;
      const key = shippedKey(file);
      const entry = manifest[key];
      if (!entry?.width || !entry?.height) missing.push(key);
    }

    expect(
      missing.slice(0, 8),
      `оригинал есть, а размеров в манифесте нет — <img> уедет без width/height (всего ${missing.length}):\n${missing.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });

  // Обратная сторона: генератор собирает манифест обходом public/media и НИЧЕГО
  // оттуда не удаляет. Удалённый оригинал оставляет и производную, и запись —
  // то есть манифест начинает описывать файл, которого в источнике правды уже
  // нет, а страница может продолжать на него ссылаться. Сейчас расхождения
  // ноль, поэтому фиксируем это состояние.
  it('в манифесте нет записей без оригинала', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, unknown>;
    const known = new Set([...walk(ORIGINALS_DIR)].map(shippedKey));
    const orphans = Object.keys(manifest).filter((key) => !known.has(key));

    expect(
      orphans.slice(0, 8),
      `запись есть, оригинала нет — производная осталась от удалённого файла (всего ${orphans.length}):\n${orphans.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });
});
