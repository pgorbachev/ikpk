import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Манифест описывает то, что ЛЕЖИТ в public/media, а не то, что удалось скачать
// в последний раз. Он кормит подстановку width/height у <img> — то есть защиту
// от сдвига макета. Пересборка манифеста из результатов загрузки молча теряла
// записи, если запрос к источнику упал: файл на месте, размеров у него больше
// нет. Так пропали 6 обложек видео — они приходят не из бакета, а с
// видеохостинга, и их адрес в бакете отдаёт 404.
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const MEDIA_DIR = join(PUBLIC_DIR, 'media');
const RASTER = /\.(webp|jpe?g|png|gif)$/i;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (RASTER.test(name)) yield full;
  }
}

describe('media manifest', () => {
  it('covers every raster image present in public/media', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'media-manifest.json'), 'utf-8'),
    ) as Record<string, { width?: number; height?: number }>;

    const missing: string[] = [];
    for (const file of walk(MEDIA_DIR)) {
      const key = file.replace(PUBLIC_DIR, '');
      // /media/_w/** — адаптивные варианты. Своих записей в манифесте у них нет
      // по замыслу: доступные ширины перечислены у базового файла в widths,
      // оттуда собирается srcset.
      if (key.startsWith('/media/_w/')) continue;
      const entry = manifest[key];
      if (!entry?.width || !entry?.height) missing.push(key);
    }

    expect(
      missing.slice(0, 8),
      `файл есть, а размеров в манифесте нет — <img> уедет без width/height (всего ${missing.length}):\n${missing.slice(0, 8).join('\n')}`,
    ).toEqual([]);
  });
});
