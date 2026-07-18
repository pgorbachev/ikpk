/**
 * Локализация медиа-ассетов (Этап 2, план 004).
 *
 * Все файлы бакета storage.yandexcloud.net/ikpk-image скачаны в public/
 * по пути бакета 1:1 (scripts/download-media.ts), поэтому рерайт URL —
 * чистая замена префикса. Манифест размеров генерируется тем же скриптом
 * и используется для проставления width/height у <img> (защита от CLS).
 */
import manifest from './media-manifest.json';

export const BUCKET_PREFIX = 'https://storage.yandexcloud.net/ikpk-image';

interface ManifestEntry {
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
}

const MANIFEST = manifest as Record<string, ManifestEntry>;

/** Заменяет все URL бакета на локальные пути в произвольной строке (включая HTML/JSON). */
export function localizeAssetUrls(text: string): string {
  if (!text) return text;
  return text.replaceAll(BUCKET_PREFIX, '');
}

/** Размеры локального ассета по его пути (например, /media/users/1/images/x.webp). */
export function getAssetDimensions(path: string): { width: number; height: number } | undefined {
  let entry = MANIFEST[path];
  if (!entry) {
    try {
      entry = MANIFEST[decodeURI(path)];
    } catch {
      return undefined;
    }
  }
  if (entry?.width && entry?.height) return { width: entry.width, height: entry.height };
  return undefined;
}

/**
 * Проставляет width/height у <img src="/media/...">, где их нет — по манифесту.
 * Браузер резервирует место до загрузки картинки → нет сдвига макета (CLS).
 */
export function injectImgDimensions(html: string): string {
  if (!html || !html.includes('<img')) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\bwidth\s*=/.test(tag) && /\bheight\s*=/.test(tag)) return tag;
    const srcMatch = tag.match(/\bsrc\s*=\s*"([^"]+)"/i);
    if (!srcMatch || !srcMatch[1].startsWith('/')) return tag;
    const dim = getAssetDimensions(srcMatch[1]);
    if (!dim) return tag;
    return tag.replace(/^<img\b/i, `<img width="${dim.width}" height="${dim.height}"`);
  });
}
