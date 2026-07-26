/**
 * Локализация медиа-ассетов (Этап 2, план 004).
 *
 * Все файлы бакета storage.yandexcloud.net/ikpk-image скачаны в public/
 * по пути бакета 1:1 (scripts/download-media.ts), поэтому рерайт URL —
 * чистая замена префикса. Манифест размеров генерируется тем же скриптом
 * и используется для проставления width/height у <img> (защита от CLS).
 */
import manifest from './media-manifest.json';

// Продублирован в scripts/download-media.ts (разные npm-пакеты) —
// при изменении бакета править ОБА места.
export const BUCKET_PREFIX = 'https://storage.yandexcloud.net/ikpk-image';

interface ManifestEntry {
  width?: number;
  height?: number;
  /** Ширины адаптивного набора, доступные для этого файла (см. scripts/make-derivatives.ts). */
  widths?: number[];
}

const MANIFEST = manifest as Record<string, ManifestEntry>;

/** Заменяет все URL бакета на локальные пути в произвольной строке (включая HTML/JSON). */
export function localizeAssetUrls(text: string): string {
  if (!text) return text;
  return text.replaceAll(BUCKET_PREFIX, '');
}

/**
 * Размеры локального ассета по его пути (например, /media/users/1/images/x.webp).
 * Ключи манифеста хранятся в декодированном виде; src может прийти percent-encoded.
 */
export function getAssetDimensions(path: string): { width: number; height: number } | undefined {
  let key = path;
  try {
    key = decodeURI(path);
  } catch {
    // битая %-последовательность — ищем как есть
  }
  const entry = MANIFEST[key];
  if (entry?.width && entry?.height) return { width: entry.width, height: entry.height };
  return undefined;
}

/**
 * Адаптивный набор для srcset: /media/_w/<ширина>/<путь>.
 *
 * Зачем: список статей показывает 68 карточек примерно по 300–400px, а базовый
 * файл отдаётся на 1200px — это давало 2,7 МБ картинок на одной странице.
 * Варианты собираются пред-сборочным скриптом и перечислены в манифесте, чтобы
 * ссылаться только на существующие файлы.
 */
export function srcsetFor(path: string): string | undefined {
  let key = path;
  try {
    key = decodeURI(path);
  } catch {
    // битая %-последовательность — ищем как есть
  }
  const widths = MANIFEST[key]?.widths;
  if (!widths?.length) return undefined;

  return widths
    .map((w) => `/media/_w/${w}${encodeURI(key.replace(/^\/media/, ''))} ${w}w`)
    .join(', ');
}

/**
 * Проставляет width/height у <img src="/media/...">, где их нет — по манифесту.
 * Браузер резервирует место до загрузки картинки → нет сдвига макета (CLS).
 * Тег с ЛЮБЫМ из атрибутов не трогаем — уважаем авторский размер и не плодим
 * дубликаты атрибутов.
 */
export function injectImgDimensions(html: string): string {
  if (!html || !html.includes('<img')) return html;

  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const src = srcMatch?.[1] ?? srcMatch?.[2];
    if (!src || !src.startsWith('/')) return tag;

    let out = tag;

    // ── 1. Адаптивный набор.
    //
    // Легаси-разметка Next.js приносит свой srcset вида «файл 1x, тот же файл
    // 2x»: адаптивности в нём нет, браузер в любом случае грузит базовую версию
    // на 1200px. Такой заменяем своим. Осмысленный (несколько РАЗНЫХ адресов)
    // не трогаем.
    //
    // Подсказка размера — во всю ширину на мобильном и 760px на десктопе: это
    // фактическая ширина текстовой колонки за вычетом отступов. Значение важно
    // до десятков пикселей: при «800px» браузер берёт вариант 1200, при 760px
    // укладывается в 768, и статья с 38 фотографиями весит вдвое меньше.
    const existing = out.match(/\bsrcset="([^"]*)"/i)?.[1];
    const distinctUrls = new Set(
      (existing ?? '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean),
    );
    const legacyUseless = existing !== undefined && distinctUrls.size <= 1;

    if (existing === undefined || legacyUseless) {
      const srcset = srcsetFor(src);
      if (srcset) {
        if (legacyUseless) out = out.replace(/\s*\bsrcset="[^"]*"/i, '');
        out = out.replace(
          /^<img\b/i,
          `<img srcset="${srcset}" sizes="(max-width: 900px) 100vw, 760px"`,
        );
      }
    }

    // ── 2. Размеры. Только если их нет: уважаем авторский размер и не плодим
    // дубликаты атрибутов. Это отдельный шаг — тег с готовыми размерами всё
    // равно должен получить адаптивный набор выше.
    if (!/[\s"']width\s*=/.test(out) && !/[\s"']height\s*=/.test(out)) {
      const dim = getAssetDimensions(src);
      if (dim) {
        out = out.replace(/^<img\b/i, `<img width="${dim.width}" height="${dim.height}"`);
      }
    }

    // ── 3. Приоритеты загрузки.
    //
    // Легаси-разметка ставит fetchpriority="high" КАЖДОЙ картинке: в статье с
    // 38 фотографиями 38 «высокоприоритетных» запросов конкурируют друг с
    // другом и с элементом, по которому считается LCP. Приоритет имеет смысл
    // только у одной картинки на странице, и назначать его должен шаблон, а не
    // импортированный контент. Заодно ставим ленивую загрузку там, где её нет:
    // 38 фотографий ниже первого экрана грузить сразу незачем.
    out = out.replace(/\s*\bfetchpriority="[^"]*"/i, '');
    if (!/\bloading\s*=/.test(out)) {
      out = out.replace(/^<img\b/i, '<img loading="lazy"');
    }

    return out;
  });
}

