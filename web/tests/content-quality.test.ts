import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dist, walkHtml, walkFiles } from './helpers/dist-pages';

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
      // Требуем, чтобы внутри тега шло слово: `клетки<em>.</em>` — это
      // курсивная точка, пробел там не нужен, а `нами:<a>+7…` — потеря.
      for (const m of html.matchAll(/[а-яё:](?:<a\s[^>]*>|<strong>|<em>)[\wа-яё+]/gi)) {
        const at = Math.max(0, m.index! - 45);
        offenders.push(`${file.replace(dist, '')}: …${html.slice(at, m.index! + 25)}…`);
      }
    }
    expect(
      offenders.slice(0, 8),
      `текст склеился с инлайн-тегом (потерян пробел):\n${offenders.slice(0, 8).join('\n')}`
    ).toEqual([]);
  });

  // Документ, который лежит в сборке, но на который нет ни одной ссылки,
  // недостижим для посетителя. Для «Пользовательского соглашения» это ещё и
  // юридическая проблема: документ обязателен, а дойти до него нельзя.
  // На живом сайте ссылки есть — значит мы их потеряли при переносе.
  it('no PDF in the build without a single link to it', () => {
    const html = [...walkHtml()].map((f) => readFileSync(f, 'utf-8')).join('');
    const orphans: string[] = [];
    for (const file of walkFiles(dist, ['.pdf'])) {
      const rel = file.replace(dist, '');
      const name = rel.split('/').pop()!;
      const reachable =
        html.includes(rel) ||
        html.includes(encodeURI(rel)) ||
        html.includes(name) ||
        html.includes(encodeURIComponent(name));
      if (!reachable) orphans.push(rel);
    }
    expect(
      orphans,
      `PDF в сборке, на который никто не ссылается:\n${orphans.join('\n')}`
    ).toEqual([]);
  });

  // <ul>/<ol> может содержать только <li>. Когда мы снимаем маркеры с
  // аккордеонов, заменяя <li> на <div>, легко забыть внешний список — тогда
  // остаётся <ul><div>…</div></ul>: невалидная разметка, поведение зависит
  // от браузера.
  it('no non-li children directly inside lists', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<(?:ul|ol)[^>]*>\s*<(?!li[\s>])([a-z]+)/gi)) {
        offenders.push(`${file.replace(dist, '')}: <ul> сразу содержит <${m[1]}>`);
      }
    }
    expect(
      offenders.slice(0, 6),
      `невалидный список (внутри не <li>):\n${offenders.slice(0, 6).join('\n')}`
    ).toEqual([]);
  });

  // Аккордеон без содержимого — заголовок раскрывается в пустоту. На
  // /svedeniya-ob-obrazovatelnoy-organizatsii так вышло у всех 17 разделов:
  // на живом сайте это Radix Collapsible, закрытые панели не смонтированы
  // в DOM, поэтому контент не попал в скрейп. Страница обязательна по
  // требованиям к раскрытию информации образовательной организацией.
  it('no accordions that open into nothing', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*<\/details>/gi)) {
        const label = m[1].replace(/<[^>]+>/g, '').trim().slice(0, 40);
        offenders.push(`${file.replace(dist, '')}: «${label}»`);
      }
    }
    expect(
      offenders.slice(0, 8),
      `аккордеон раскрывается в пустоту (контент потерян):\n${offenders.slice(0, 8).join('\n')}`
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
      // пустой <li> — висячий маркер без текста. Появляется, когда из списка
      // убрали содержимое (например пустую секцию), а обёртку оставили.
      for (const m of html.matchAll(/<li[^>]*>\s*<\/li>/gi)) {
        offenders.push(`${file.replace(dist, '')}: пустой ${m[0].slice(0, 40)}`);
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
