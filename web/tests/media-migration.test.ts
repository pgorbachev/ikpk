import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dist, walkFiles } from './helpers/dist-pages';

// ─── Этап 2 (план 004): вечный CI-гейт «0 хотлинков на чужой бакет» ─────────
// Все медиа-ассеты самохостятся из public/media (и /terms); ни одна страница
// в dist/ не должна ссылаться на storage.yandexcloud.net.

describe('media migration (Этап 2)', () => {
  // Deploy may validate a copied/staged artifact rather than the default web/dist.
  const artifact = process.env.MEDIA_MIGRATION_DIST_DIR ?? dist;

  it('dist/ contains zero hotlinks to storage.yandexcloud.net', () => {
    const offenders: string[] = [];
    for (const file of walkFiles(artifact, ['.html', '.xml', '.css', '.js', '.json', '.txt'])) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('storage.yandexcloud.net')) {
        offenders.push(file.replace(artifact, ''));
      }
    }
    expect(offenders, `hotlinks found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  // Обобщённый гейт вместо «нет одного конкретного хоста»: любая картинка
  // обязана резолвиться ЛОКАЛЬНО. Гейт выше пропускал ссылки на умирающий
  // деплой старого сайта (ikpk.su/_next/static/media/**): три эмблемы
  // институтов на главной отвалились бы разом при переключении DNS, а иконки
  // министерств были 404 уже тогда — и всё это при зелёном CI.
  it('every image reference resolves locally — no external image hosts', () => {
    // Разрешены только самохостинг (root-relative) и явно неизображенческие
    // схемы. Внешние картинки (любой хост) запрещены: домен может умереть.
    const external: string[] = [];
    const missing: string[] = [];
    // Третий класс: ссылка, которая не является ни схемой, ни путём от корня сайта.
    // Прежде такие молча пропускались (`if (!ref.startsWith('/')) continue;`) — и вместе с
    // ними проходило `src="[object Object]"`, наблюдённое на стенде у карточек
    // преподавателей: поле снимка пришло объектом там, где сайт читает строку. Тишина здесь
    // была тем же, чем «дефектов нет» вместо «я не смогла проверить»: адрес, которого не
    // существует ни в каком прочтении, гейт признавал не своим предметом.
    const unresolvable: string[] = [];

    for (const file of walkFiles(artifact, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      const page = file.replace(artifact, '');

      // <img src>, <img srcset>, <source src/srcset>, CSS url() в инлайн-стилях
      const refs: string[] = [];
      for (const m of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
        const tag = m[0];
        const src = tag.match(/\bsrc="([^"]+)"/i)?.[1];
        if (src) refs.push(src);
        const srcset = tag.match(/\bsrcset="([^"]+)"/i)?.[1];
        if (srcset) {
          for (const cand of srcset.split(',')) {
            const url = cand.trim().split(/\s+/)[0];
            if (url) refs.push(url);
          }
        }
      }
      for (const m of html.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) refs.push(m[2]);

      // JSON-LD: image/logo — значения внутри JSON-строки, теги их не ловят
      for (const m of html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
      )) {
        for (const f of m[1].matchAll(/"(?:image|logo|thumbnailUrl)"\s*:\s*"([^"]+)"/gi)) {
          // JSON-LD требует АБСОЛЮТНЫЙ URL, поэтому свой домен здесь легитимен:
          // проверяем, что это наш домен, и что путь существует локально
          const val = f[1];
          const own = val.replace(/^https:\/\/ikpk\.su/, '');
          refs.push(own === val ? val : own);
        }
      }

      for (const raw of refs) {
        const ref = raw.trim();
        if (!ref || ref.startsWith('data:')) continue;
        if (/^(?:https?:)?\/\//.test(ref)) {
          // единственное исключение — пиксели счётчиков в <noscript>,
          // это не контентные картинки, а трекеры
          if (/mc\.yandex\.ru\/watch\/|top-fwz1\.mail\.ru\/counter/.test(ref)) continue;
          external.push(`${page}: ${ref}`);
          continue;
        }
        // Ссылка на фрагмент того же документа — законный предмет у `url()` внутри inline-SVG
        // (`fill="url(#clip0_519_1997)"`). Измерено на этой сборке: таких три, все из логотипа
        // в шапке; всё остальное, не начинающееся со слэша, адресом не является.
        if (ref.startsWith('#')) continue;
        if (!ref.startsWith('/')) {
          unresolvable.push(`${page}: ${ref}`);
          continue;
        }
        const local = join(artifact, decodeURI(ref.split('?')[0].split('#')[0]));
        if (!existsSync(local)) missing.push(`${page}: ${ref}`);
      }
    }

    // CSS-бандлы: background-image из <style> в .astro попадает в dist/_astro/*.css,
    // а не в HTML — без этого прохода внешняя картинка в CSS ускользала от обоих гейтов
    for (const file of walkFiles(artifact, ['.css'])) {
      const css = readFileSync(file, 'utf-8');
      for (const m of css.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) {
        const ref = m[2].trim();
        if (!ref || ref.startsWith('data:')) continue;
        if (/^(?:https?:)?\/\//.test(ref)) {
          external.push(`${file.replace(artifact, '')}: ${ref}`);
        }
      }
    }

    expect(external, `внешние картинки (домен может умереть):\n${external.slice(0, 15).join('\n')}`).toEqual([]);
    expect(missing, `битые локальные ссылки:\n${missing.slice(0, 15).join('\n')}`).toEqual([]);
    expect(
      unresolvable.slice(0, 15),
      `адрес изображения не является ни схемой, ни путём от корня сайта ` +
        `(так выглядит поле снимка, пришедшее объектом), всего ${unresolvable.length}:\n` +
        unresolvable.slice(0, 15).join('\n'),
    ).toEqual([]);
  });

  // Гейт на класс «ссылка/действие работает только благодаря старому сайту».
  // Формы с action="#" на статике = POST на .html → 405 от nginx и уход со
  // страницы. Пока FR-06/07 не подключены к Bitrix24, отправка должна быть
  // заглушена, а не «как бы работать».
  it('no form can POST to a static page (405 guard)', () => {
    const offenders: string[] = [];
    for (const file of walkFiles(artifact, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
        const tag = m[0];
        const action = tag.match(/\baction="([^"]*)"/i)?.[1] ?? '';
        const isSelfPost = /\bmethod="post"/i.test(tag) && (action === '' || action === '#');
        const stopped = /\bonsubmit="return false"/i.test(tag) || /\bdisabled\b/i.test(tag);
        if (isSelfPost && !stopped) {
          offenders.push(`${file.replace(artifact, '')}: ${tag.slice(0, 110)}`);
        }
      }
    }
    expect(
      offenders.slice(0, 5),
      `формы отправляют POST на статику (405 + уход со страницы):\n${offenders.slice(0, 5).join('\n')}`
    ).toEqual([]);
  });

  it('local media assets are present in dist', () => {
    const mediaDir = join(artifact, 'media');
    expect(existsSync(mediaDir)).toBe(true);
    const count = [...walkFiles(mediaDir, ['.webp'])].length;
    expect(count).toBeGreaterThanOrEqual(170);
  });

  it('every /media|/terms reference across ALL dist pages resolves to a local file', () => {
    // Исчерпывающая проверка (не выборка): локализация URL в loadJson безусловна,
    // поэтому недокачанный ассет дал бы тихий 404 — ловим здесь.
    const missing: string[] = [];
    for (const file of walkFiles(artifact, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      const refs = [
        ...html.matchAll(/\b(?:src|href)="(\/(?:media|terms)\/[^"]+)"/gi),
      ].map((m) => m[1]);
      for (const ref of refs) {
        const local = join(artifact, decodeURI(ref.split('?')[0]));
        if (!existsSync(local)) missing.push(`${file.replace(artifact, '')}: ${ref}`);
      }
    }
    expect(missing, `missing local assets:\n${missing.join('\n')}`).toEqual([]);
  });

  it('content images carry width/height (CLS guard)', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const file of walkFiles(artifact, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
        const tag = match[0];
        if (!/\bsrc="\/media\//i.test(tag)) continue;
        total += 1;
        if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) {
          offenders.push(`${file.replace(artifact, '')}: ${tag.slice(0, 110)}`);
        }
      }
    }
    expect(total, 'в артефакте нет ни одного изображения — проверка вакуумна').toBeGreaterThan(0);
    expect(offenders, `img lacks dimensions:\n${offenders.slice(0, 10).join('\n')}`).toEqual([]);
  });
});
