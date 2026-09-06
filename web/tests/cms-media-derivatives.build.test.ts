// Тесты по утверждённой спеке `cms-media-pipeline`
// (`openspec/changes/cms-content-authoring-and-migration/specs/cms-media-pipeline/spec.md`),
// требование «У каждого отдаваемого изображения есть производные и известные размеры».
//
// Предмет — СОБРАННОЕ дерево и манифест, которым оно собрано, поэтому файл живёт в наборе
// `vitest.build.config.ts` вместе с остальными `*.build.test.ts`.
//
// ЭТИ ПРОВЕРКИ ЗЕЛЁНЫЕ НА ФИКСТУРЕ, и это сказано прямо: закреплённый снимок несёт только
// легаси-медиа репозитория, медиа системы управления в нём нет вовсе. Красными по отсутствию
// реализации они станут ровно в тот прогон, где сборка идёт живым снимком, — то есть здесь
// это ГЕЙТ, а не красный тест, и его негативная проверка выполнена мутацией (см. отчёт
// сессии). Красные тесты того же требования, не зависящие от сборки, лежат в
// `web/tests/cms-media-capture.test.ts` и `web/tests/cms-media-delivery.test.ts`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dist, walkFiles } from './helpers/dist-pages';
import { CMS_UPLOADS_PREFIX } from './helpers/cms-media-pipeline-contract';

const WEB_ROOT = join(import.meta.dirname, '..');

/** Снимок, которым собрано дерево, а не тот, что лежит в фикстуре: предмет — эта сборка. */
const snapshot = JSON.parse(
  readFileSync(join(WEB_ROOT, 'dist-snapshot', 'snapshot.json'), 'utf-8'),
) as { content: { media?: { ref: string; contentId: string }[] } };

const manifest = JSON.parse(
  readFileSync(join(WEB_ROOT, 'src', 'lib', 'media-manifest.json'), 'utf-8'),
) as Record<string, { width?: number; height?: number; widths?: number[] }>;

const media = snapshot.content.media ?? [];
const imageRef = /\.(?:webp|jpe?g|png|gif)$/i;

describe('производные и размеры отдаваемых изображений', () => {
  // Сценарий: новое изображение получает производные и размеры
  it('у каждого медиа снимка известны собственные ширина и высота', () => {
    // Пустой список — «проверить не удалось», а не «дефектов нет»: снимок без медиа означает
    // либо что их не снимали (наблюдённый дефект), либо что проверять нечего.
    expect(media.length, 'в снимке сборки нет ни одного медиа — проверка вакуумна').toBeGreaterThan(0);

    const unknown = media
      .filter((m) => {
        const entry = manifest[m.ref];
        return imageRef.test(m.ref) && (!entry || !entry.width || !entry.height);
      })
      .map((m) => m.ref);

    expect(unknown, `медиа без записи о размерах:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('файл каждого медиа снимка лежит в собранном дереве', () => {
    const missing = media.filter((m) => !existsSync(join(dist, decodeURI(m.ref)))).map((m) => m.ref);
    expect(missing, `медиа снимка нет в сборке:\n${missing.join('\n')}`).toEqual([]);
  });

  // Сценарий: адаптивный набор не ссылается на отсутствующие файлы.
  //
  // Апскейла нет, но для небольшого оригинала генератор создаёт производную меньшей либо
  // собственной ширины. Поэтому пустой набор ширин у растрового медиа — уже дефект, а не
  // допустимое legacy-исключение.
  it('каждая ширина адаптивного набора соответствует существующему файлу', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const m of media.filter((item) => imageRef.test(item.ref))) {
      for (const w of manifest[m.ref]?.widths ?? []) {
        checked += 1;
        const variant = join(dist, 'media', '_w', String(w), decodeURI(m.ref).replace(/^\/media\//, ''));
        if (!existsSync(variant)) broken.push(`${m.ref} @${w}w`);
      }
    }
    expect(checked, 'ни у одного медиа снимка нет адаптивного набора — проверка вакуумна').toBeGreaterThan(0);
    expect(broken, `набор ссылается на отсутствующие файлы:\n${broken.join('\n')}`).toEqual([]);
    const withoutVariants = media
      .filter((item) => imageRef.test(item.ref))
      .filter((item) => !(manifest[item.ref]?.widths?.length))
      .map((item) => item.ref);
    expect(withoutVariants, `медиа без производных ширин:\n${withoutVariants.join('\n')}`).toEqual([]);
  });

  // Сценарий: изображение без известных размеров останавливает сборку.
  //
  // Проверяется по СЛЕДСТВИЮ: страница без размеров изображения — тот самый сдвиг раскладки,
  // ради которого требование и написано. Проверка идёт по всем страницам, а не по одной
  // статье, как соседний гейт `media-migration` («content images carry width/height»).
  it('ни одно отдаваемое изображение на страницах не осталось без размеров', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const file of walkFiles(dist, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
        const tag = m[0];
        const src = tag.match(/\bsrc="([^"]+)"/i)?.[1];
        if (!src || !src.startsWith('/media/')) continue;
        total += 1;
        if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) {
          offenders.push(`${file.replace(dist, '')}: ${tag.slice(0, 120)}`);
        }
      }
    }
    expect(total, 'на страницах нет ни одного изображения — проверка вакуумна').toBeGreaterThan(0);
    expect(
      offenders.slice(0, 10),
      `изображения без размеров (сдвиг раскладки), всего ${offenders.length}:\n${offenders.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });
});

// ══════════ Требование: изображения отдаются с сайта, а не из системы управления ══════════

describe('в собранном дереве нет адресов каталога загрузок системы управления', () => {
  // Сценарий: страница с загруженным изображением не ссылается на систему управления.
  // Карта сайта и структурированные данные названы требованием отдельно, поэтому обход идёт
  // по HTML, XML и JSON, а не только по страницам.
  it('ни страница, ни карта сайта, ни структурированные данные не ссылаются на /uploads/', () => {
    const offenders: string[] = [];
    for (const file of walkFiles(dist, ['.html', '.xml', '.json', '.css', '.js'])) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes(`"${CMS_UPLOADS_PREFIX}`) || content.includes(`'${CMS_UPLOADS_PREFIX}`)) {
        offenders.push(file.replace(dist, ''));
      }
    }
    expect(
      offenders.slice(0, 10),
      `адрес каталога загрузок дожил до сборки, всего ${offenders.length}:\n${offenders.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });
});
