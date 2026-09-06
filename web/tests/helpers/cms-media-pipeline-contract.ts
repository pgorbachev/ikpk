// Контракт медиа-конвейера системы управления: change `cms-content-authoring-and-migration`,
// спека `cms-media-pipeline`.
//
// Тесты по спеке пишутся раньше реализации (AGENTS.md, «Тесты по спеке пишутся в отдельной
// сессии и раньше кода»). Часть предмета ещё не существует — материализация медиа снимка на
// диск сборки, — поэтому модуль загружается ДИНАМИЧЕСКИ через `loadModule`: статический
// импорт несуществующего экспорта валит `astro check`, и тогда красный прогон нельзя
// отличить от сломанного дерева.
//
// Имена и пути названы ЗДЕСЬ и только здесь. Реализация вправе выбрать другое расположение,
// но тогда обязана поправить константу в этом файле, а не завести второй набор имён.

import { loadModule, type MediaStoreModule } from './cms-content-publication-contract';

/** Каталог загрузок системы управления: под этим префиксом Strapi отдаёт медиа. */
export const CMS_UPLOADS_PREFIX = '/uploads/';

/**
 * Префикс, под которым те же файлы отдаются СО СТАТИЧЕСКИХ адресов сайта.
 *
 * `/media/**` — уже существующее дерево отдаваемых изображений (`web/public/media`,
 * генерируется `web/scripts/make-derivatives.ts`), поэтому медиа системы управления ложится
 * туда же отдельным поддеревом, а не заводит второй корень: манифест размеров, адаптивный
 * набор `srcsetFor` и гейт `media-migration` уже умеют один корень и не должны учить второй.
 */
export const SITE_MEDIA_PREFIX = '/media/uploads/';

/**
 * Каталог контент-адресуемого хранилища ВНУТРИ каталога снимка: `<снимок>/media/<contentId>`.
 * Та же форма, что проверяют существующие тесты хранилища (`web/tests/cms-snapshot-media.test.ts`:
 * файл назван идентификатором содержимого и лежит плоско в каталоге).
 */
export const SNAPSHOT_MEDIA_DIRNAME = 'media';

/** Модуль хранилища медиа с материализацией — сама функция ЕЩЁ НЕ СУЩЕСТВУЕТ. */
export interface MediaStoreWithMaterialize extends MediaStoreModule {
  /**
   * Раскладывает медиа снимка на диск под адресами отдачи: ссылке `/media/uploads/x.webp`
   * соответствует файл `<destDir>/uploads/x.webp`.
   *
   * Байты берутся из хранилища и ПРОВЕРЯЮТСЯ по идентификатору содержимого: подмена — отказ
   * с указанием ссылки, а не молча разложенный чужой файл.
   */
  materializeInto(input: {
    storeDir: string;
    destDir: string;
    media: { ref: string; contentId: string }[];
  }):
    | { ok: true; written: string[] }
    | { ok: false; reason: 'content-id-mismatch' | 'missing'; ref: string; contentId: string };
}

export const mediaStoreModule = (): Promise<MediaStoreWithMaterialize> =>
  loadModule<MediaStoreWithMaterialize>('../../scripts/lib/content-media-store.ts');

/**
 * Загружает будущий экспорт существующего модуля. `loadModule` проверяет только наличие
 * ФАЙЛА, а `content-media-store.ts` уже есть — отсутствие функции внутри него дало бы
 * `TypeError: … is not a function` из глубины теста вместо внятного «не реализовано».
 */
export async function requireExport<T extends object, K extends keyof T>(
  mod: Promise<T>,
  name: K,
): Promise<NonNullable<T[K]>> {
  const loaded = await mod;
  const value = loaded[name];
  if (typeof value !== 'function') {
    throw new Error(
      `НЕ РЕАЛИЗОВАНО: в web/scripts/lib/content-media-store.ts нет ${String(name)}. ` +
        `Тест написан по утверждённой спеке cms-media-pipeline раньше реализации.`,
    );
  }
  return value as NonNullable<T[K]>;
}

// --------------------------------------------------------------- обход снимка

/**
 * Ссылки на каталог загрузок системы управления, встреченные в записях снимка.
 *
 * Обход общий, а не по перечню полей: перечень полей отстаёт от предмета молча — ровно тот
 * класс ошибки, из-за которого `content.media` оказался пустым при объявленном поле
 * (AGENTS.md, «не перечислять частные случаи того, что проверяешь»).
 */
export function uploadRefsIn(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.includes(CMS_UPLOADS_PREFIX)) found.add(node);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item);
    }
  };
  walk(value);
  return [...found];
}
