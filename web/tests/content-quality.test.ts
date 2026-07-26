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

  // Адреса старого сайта — без завершающего слэша (ikpk.su/kontakty). У нас
  // из-за дефолта Astro получалось /kontakty/, то есть после переключения DNS
  // канонический адрес всех 245 совпадающих страниц сменился бы и поисковик
  // переиндексировал бы сайт целиком. Решение владельца (2026-07-26): привести
  // к виду старого сайта.
  it('canonical, og:url and sitemap have no trailing slash', () => {
    const offenders: string[] = [];

    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(
        /(?:rel="canonical" href|property="og:url" content)="(https:\/\/ikpk\.su\/[^"]*)"/g
      )) {
        // главная — единственный адрес, где слэш уместен
        if (m[1] !== 'https://ikpk.su/' && m[1].endsWith('/')) {
          offenders.push(`${file.replace(dist, '')}: ${m[1]}`);
        }
      }
    }

    for (const map of walkFiles(dist, ['.xml'])) {
      for (const m of readFileSync(map, 'utf-8').matchAll(/<loc>(https:\/\/ikpk\.su\/[^<]*)<\/loc>/g)) {
        if (m[1] !== 'https://ikpk.su/' && m[1].endsWith('/')) {
          offenders.push(`${map.replace(dist, '')}: ${m[1]}`);
        }
      }
    }

    // и сами внутренние ссылки — иначе посетитель попадёт на адрес, с которого
    // сервер его редиректит, а это лишний переход на каждом клике
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<a\b[^>]*\bhref="(\/[^"#?]*\/)"/gi)) {
        if (m[1] !== '/') offenders.push(`${file.replace(dist, '')}: ссылка ${m[1]}`);
      }
    }

    const uniq = [...new Set(offenders)];
    expect(
      uniq.slice(0, 6),
      `адрес со завершающим слэшем — расходится со старым сайтом (всего ${uniq.length}):\n${uniq.slice(0, 6).join('\n')}`
    ).toEqual([]);
  });

  // Форма-заглушка, которая собирает персональные данные и никуда их не
  // отправляет, — хуже отсутствия формы: посетитель считает, что подписался.
  // На старом сайте «Подписаться» было обычной ссылкой на форму Bitrix24.
  // Отдельно: у заглушки был чекбокс согласия на обработку персональных данных
  // без ссылки на документ и без указания, кто обработчик.
  it('no dead forms collecting personal data', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
        const form = m[0];
        const dead =
          /onsubmit\s*=\s*"return false"/i.test(form) ||
          /\baction\s*=\s*"#"/i.test(form);
        const collectsPii = /type="(?:tel|email)"/i.test(form) || /name="(?:phone|email|name)"/i.test(form);
        if (dead && collectsPii) {
          offenders.push(file.replace(dist, ''));
        }
      }
    }
    const uniq = [...new Set(offenders)];
    expect(
      uniq.slice(0, 5),
      `форма собирает персональные данные и ничего с ними не делает (страниц: ${uniq.length}):\n${uniq.slice(0, 5).join('\n')}`
    ).toEqual([]);
  });

  // Ссылки, про которые мы ЗНАЕМ, что они мертвы: проверены запросом
  // 2026-07-26. Три из них появились при переносе — ими были заменены живые
  // аккаунты старого сайта, то есть мы своими руками отправили посетителей
  // в никуда на всех 260 страницах. Гейт офлайновый: он не проверяет
  // доступность сети, а держит уже разобранные адреса вне сборки.
  const KNOWN_DEAD = [
    'vk.com/ikpksu', //           404; живое сообщество — vk.com/clubikpk
    'youtube.com/@ikpk_su', //    404; живой канал — youtube.com/user/TheKinesiology
    'vkvideo.ru/@clubikpk', //    редирект на errorCode=11300 invalid user
    't.me/ikpk_su', //            страница есть, но это не канал: нет счётчика
    //                            подписчиков; живой канал — t.me/ikpk_spb (1877)
    'www.medshop.ikpk.su', //     хост не отвечает вообще
  ];

  it('no known-dead external links in the build', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const dead of KNOWN_DEAD) {
        if (html.includes(dead)) offenders.push(`${file.replace(dist, '')}: ${dead}`);
      }
    }
    const uniq = [...new Set(offenders.map((o) => o.split(': ')[1]))];
    expect(
      uniq,
      `мёртвые ссылки в сборке (${offenders.length} вхождений):\n${uniq.join('\n')}`
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
