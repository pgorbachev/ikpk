import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dist, walkHtml } from './helpers/dist-pages';

// ─── Качество отрендеренного контента ───────────────────────────────────────
// Дефекты, которые видит глазами пользователь, но не ловят SEO/медиа-гейты.

describe('rendered content quality', () => {
  // Astro 7 сменил дефолт compressHTML на 'jsx': пробелы на границах строк
  // шаблона схлопываются. Из-за этого «Свяжитесь с нами:» склеилось с
  // телефоном, а «или» — с адресом почты (страницы /oplata и /video).
  // Исходник при этом не менялся — это регресс апгрейда.
  it('no lost whitespace between text and inline tags', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/[а-яё:](<a\s|<strong>|<em>)/gi)) {
        const at = Math.max(0, m.index! - 45);
        offenders.push(`${file.replace(dist, '')}: …${html.slice(at, m.index! + 25)}…`);
      }
    }
    expect(
      offenders.slice(0, 8),
      `текст склеился с инлайн-тегом (потерян пробел):\n${offenders.slice(0, 8).join('\n')}`
    ).toEqual([]);
  });

  // Аккордеон, завёрнутый в <li>, получает маркер списка от
  // .rich-content ul { list-style: disc } — рядом с крупными блоками
  // «Оплаты» торчат точки. Это не список, а layout-обёртка из легаси-вёрстки.
  it('no list markers around accordion blocks', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      // <li>, внутри которого (возможно через div-обёртки) лежит <details>
      for (const m of html.matchAll(/<li[^>]*>(?:\s*<div[^>]*>)*\s*<details/gi)) {
        offenders.push(`${file.replace(dist, '')}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(
      offenders.slice(0, 6),
      `аккордеон внутри <li> — у блока будет маркер списка:\n${offenders.slice(0, 6).join('\n')}`
    ).toEqual([]);
  });

  // Нативная <button> без класса = неоформленный серый контрол браузера. На /oplata
  // такая кнопка «Произвести оплату» пришла из легаси-контента: выглядит
  // чужеродно и вообще ничего не делает (обработчика нет).
  it('no unstyled native buttons in content', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<button(?![^>]*\bclass=)[^>]*>/gi)) {
        offenders.push(`${file.replace(dist, '')}: ${m[0]}`);
      }
    }
    expect(
      offenders.slice(0, 6),
      `кнопки без класса (неоформленный нативный контрол):\n${offenders.slice(0, 6).join('\n')}`
    ).toEqual([]);
  });
});
