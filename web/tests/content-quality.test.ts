import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { dist, walkHtml, walkFiles } from './helpers/dist-pages';
import { LEGACY_CTA_ATTR, LEGACY_CTA_UNRESOLVED_ATTR } from '../src/lib/html-cleaner.js';

// ─── Качество отрендеренного контента ───────────────────────────────────────
// Дефекты, которые видит глазами пользователь, но не ловят SEO/медиа-гейты.

/**
 * Элемент с данным id: открывающий тег и текст внутри. Нужен, чтобы отличить
 * якорь на живом блоке от якоря на пустышке. Разбор грубый (по вложенности
 * одноимённых тегов) — этого хватает: цель проверки не парсер, а признак
 * «под якорем что-то есть».
 */
function targetOf(html: string, id: string): { openTag: string; text: string } | null {
  const m = new RegExp(`<([a-z0-9]+)([^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*)>`, 'i').exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  if (/^(input|img|br|hr|meta|link)$/.test(tag)) return { openTag: m[0], text: '' };
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const close = new RegExp(`</${tag}>`, 'gi');
  let depth = 1;
  let pos = m.index + m[0].length;
  const start = pos;
  while (depth > 0 && pos < html.length) {
    open.lastIndex = pos; close.lastIndex = pos;
    const o = open.exec(html); const c = close.exec(html);
    if (!c) break;
    if (o && o.index < c.index) { depth += 1; pos = o.index + o[0].length; }
    else { depth -= 1; pos = c.index + c[0].length; if (depth === 0) return { openTag: m[0], text: html.slice(start, c.index).replace(/<[^>]*>/g, ' ') }; }
  }
  return { openTag: m[0], text: '' };
}

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

  // Дефект: normalizeLegacyControls переписывала любую <button> без класса в
  // ссылку на /raspisanie-i-tseny. В сборке это дало 4 кнопки на 2 страницах,
  // ведущие не туда, куда обещает подпись: «Хочу сотрудничать!» (×3 на
  // /sotrudnichestvo-s-nami) и «Произвести оплату» (на /oplata) вели в прайс.
  //
  // Первая редакция этих гейтов ПРОВЕРЯЛА МЕХАНИЗМ, А НЕ ПРЕДМЕТ: они требовали,
  // чтобы очистка не выдумывала адрес, но назначение, которое сообщила страница,
  // не проверял никто. Независимое ревью показало выполнением, что замена одной
  // строки в oplata.astro ('#oplata-svyaz' → '/raspisanie-i-tseny') возвращает
  // дефект дословно и оставляет оба гейта зелёными (44 passed, 14 passed).
  // Воспроизведено — находка подтвердилась.
  //
  // Поэтому проверяется само назначение: контрол легаси-кнопки ведёт на якорь
  // ВНУТРИ той же страницы, и этот якорь существует. Уводить на другую страницу
  // нельзя — подпись обещает действие, а не переход; семантику адреса машина не
  // проверит, а вот «свой якорь и он существует» проверит полностью.
  it('legacy CTA points at an existing anchor on its own page', () => {
    const offenders: string[] = [];
    let controls = 0;
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gi)].map((m) => m[1]));
      for (const a of html.matchAll(
        new RegExp(`<a\\s([^>]*\\b${LEGACY_CTA_ATTR}\\b[^>]*)>([^<]*)<`, 'gi')
      )) {
        controls += 1;
        const href = a[1].match(/\bhref="([^"]*)"/i)?.[1] ?? '';
        const label = a[2].trim();
        const where = `${file.replace(dist, '')}: «${label}» → ${href || '(нет href)'}`;
        if (!href.startsWith('#')) {
          offenders.push(`${where} — ведёт за пределы своей страницы`);
        } else if (!ids.has(href.slice(1))) {
          offenders.push(`${where} — якоря нет на этой странице`);
        } else {
          // Существования id мало: второй проход ревью обошёл проверку, перенеся
          // id на пустой visually-hidden span рядом с заголовком — кнопка вела
          // «никуда», а гейт молчал, потому что технически якорь был.
          // Семантику цели машина не проверит, но пустоту и сокрытие — да.
          const target = targetOf(html, href.slice(1));
          if (target === null) {
            offenders.push(`${where} — якорь есть, но элемент под ним не разобран`);
          } else if (/\baria-hidden="true"/i.test(target.openTag)) {
            offenders.push(`${where} — якорь на элементе, скрытом от AT (aria-hidden)`);
          } else if (/(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(target.openTag)) {
            offenders.push(`${where} — якорь на скрытом элементе`);
          } else if (target.text.replace(/\s+/g, '').length < 20) {
            offenders.push(`${where} — якорь на пустом элементе (текста ${target.text.replace(/\s+/g,'').length} симв.)`);
          }
        }
      }
    }
    // Отсутствие сигнала — не успех: ноль контролов значит, что проверка ничего
    // не измерила. Контролы в сборке есть по построению (легаси-кнопки на
    // /oplata и /sotrudnichestvo-s-nami), их исчезновение — тоже сигнал.
    expect(
      controls,
      'легаси-контролов в сборке не найдено — проверка ничего не измерила'
    ).toBeGreaterThan(0);
    expect(offenders, `легаси-кнопка ведёт не туда:\n${offenders.join('\n')}`).toEqual([]);
  });

  // Свойство шире предыдущего и полезно само по себе: внутристраничная ссылка,
  // ведущая в несуществующий фрагмент, ничего не делает по клику. Ревью нашло
  // это опечаткой в моём же якоре ('-sviaz' вместо '-svyaz'), которая прошла обе
  // проверки зелёной.
  it('every in-page fragment link resolves to an element on that page', () => {
    const offenders: string[] = [];
    let links = 0;
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gi)].map((m) => m[1]));
      for (const a of html.matchAll(/<a\s[^>]*\bhref="#([^"]+)"/gi)) {
        links += 1;
        const frag = decodeURIComponent(a[1]);
        if (!ids.has(frag) && frag !== 'top') {
          offenders.push(`${file.replace(dist, '')}: #${frag}`);
        }
      }
    }
    expect(links, 'внутристраничных ссылок не найдено — проверка ничего не измерила').toBeGreaterThan(0);
    expect(
      [...new Set(offenders)].slice(0, 10),
      `ссылка ведёт в несуществующий фрагмент:\n${[...new Set(offenders)].slice(0, 10).join('\n')}`
    ).toEqual([]);
  });

  it('no unresolved legacy control left in the build', () => {
    const offenders: string[] = [];
    let pages = 0;
    for (const file of walkHtml()) {
      pages += 1;
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(
        new RegExp(`${LEGACY_CTA_UNRESOLVED_ATTR}[^>]*>([^<]*)<`, 'gi')
      )) {
        offenders.push(`${file.replace(dist, '')}: «${m[1].trim()}»`);
      }
    }
    expect(pages, 'в dist не найдено ни одной страницы — проверка ничего не измерила').toBeGreaterThan(0);
    expect(
      offenders,
      `контрол из легаси-контента остался без адреса — страница не сообщила, куда он ведёт:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

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
  // Признак сменён с «кнопка без класса» на «кнопка не из наших компонентов».
  // Прежняя формулировка повторяла регулярку самой очистки и была слепа ровно
  // там же: кнопка с ЛЮБЫМ непустым классом не подпадала ни под нормализацию, ни
  // под этот гейт — мёртвый контрол в контенте прошёл бы незамеченным. Найдено
  // вторым проходом ревью.
  //
  // Astro метит элементы своих компонентов атрибутом data-astro-cid-*, а разметку
  // из set:html не метит. Кнопка без этой метки пришла из контента, значит её
  // обработчик остался на старом сайте и контрол мёртв.
  it('no raw content-derived buttons in the build', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<button\s([^>]*)>/gi)) {
        if (/data-astro-cid-/i.test(m[1])) continue;
        offenders.push(`${file.replace(dist, '')}: ${m[0]}`);
      }
    }
    expect(
      offenders.slice(0, 6),
      `мёртвая кнопка из контента (обработчик остался на старом сайте):\n${offenders.slice(0, 6).join('\n')}`
    ).toEqual([]);
  });
});

// ─── Вес изображений на странице ─────────────────────────────────────────────
// Бюджеты в seo-package.test.ts считают ТОЛЬКО размер HTML, поэтому тяжёлые
// картинки им не видны: страница со 8 МБ изображений проходила все гейты.
// Дыра вскрылась, когда загрузчик перестал уменьшать оригиналы (это было
// правильно — он уничтожал исходники), и в public/ легли файлы до 3520px.
// Правильная схема — оригинал в репозитории, производная на странице; этот
// гейт держит вторую половину.
describe('page image weight', () => {
  // Оценка ПО РАЗМЕТКЕ, а не по реальной загрузке: браузер здесь не
  // запускается, кандидат из srcset выбирается по ширине показа из sizes.
  // Поэтому считаем оба сценария — обычный экран и экран с удвоенной
  // плотностью, где браузер берёт вариант вдвое шире. Раньше гейт молча
  // моделировал только DPR 1 и выдавал это за «то, что загрузит браузер».
  const BUDGETS = [
    { dpr: 1, perImageKb: 80, totalKb: 2000 },
    { dpr: 2, perImageKb: 190, totalKb: 4200 },
  ];

  /** Вес картинок страницы при заданной плотности экрана. */
  function weigh(html: string, dpr: number): { kb: number; count: number } {
    let total = 0;
    const counted = new Set<string>();

    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = m[0];
      const src = tag.match(/\bsrc="(\/media\/[^"]+)"/i)?.[1];
      if (!src || counted.has(src)) continue;
      counted.add(src);

      const srcset = tag.match(/\bsrcset="([^"]+)"/i)?.[1];
      const sizes = tag.match(/\bsizes="([^"]+)"/i)?.[1] ?? '';
      // ширина показа на десктопе — последнее значение в sizes (после медиа-условий)
      const cssWidth = Number(sizes.match(/(\d+)px\s*$/)?.[1] ?? 800);
      const needed = cssWidth * dpr;

      let file = join(dist, decodeURIComponent(src).replace(/^\//, ''));
      if (srcset) {
        const cands = srcset.split(',').map((part) => {
          const [url, w] = part.trim().split(/\s+/);
          return { url, w: Number(w.replace('w', '')) };
        });
        const fit = cands.filter((c) => c.w >= needed).sort((a, b) => a.w - b.w)[0] ?? cands.at(-1)!;
        file = join(dist, decodeURIComponent(fit.url).replace(/^\//, ''));
      }
      if (existsSync(file)) total += statSync(file).size;
    }

    // картинки вне <img> (например ссылки в разметке) — по базовому файлу
    for (const m of html.matchAll(/(?:src|href)="(\/media\/[^"]+\.(?:webp|jpe?g|png|gif))"/gi)) {
      if (counted.has(m[1])) continue;
      counted.add(m[1]);
      const p = join(dist, decodeURIComponent(m[1]).replace(/^\//, ''));
      if (existsSync(p)) total += statSync(p).size;
    }

    return { kb: Math.round(total / 1024), count: Math.max(counted.size, 1) };
  }

  for (const { dpr, perImageKb, totalKb } of BUDGETS) {
    it(`укладывается в бюджет при плотности экрана ${dpr}x`, () => {
      const offenders: string[] = [];

      for (const file of walkHtml()) {
        const html = readFileSync(file, 'utf-8');
        const { kb, count } = weigh(html, dpr);
        const perImage = Math.round(kb / count);

        // средний вес имеет смысл только по набору: на странице преподавателя
        // одна крупная фотография — это содержание, а не расточительность,
        // такие случаи ловит абсолютный потолок
        if (count >= 4 && perImage > perImageKb) {
          offenders.push(`${file.replace(dist, '')}: ${perImage} КБ на картинку (${kb} КБ / ${count})`);
        } else if (kb > totalKb) {
          offenders.push(`${file.replace(dist, '')}: ${kb} КБ всего в ${count} картинках`);
        }
      }

      expect(
        offenders.slice(0, 6),
        `при ${dpr}x вне бюджета (не больше ${perImageKb} КБ на картинку и ${totalKb} КБ на страницу), страниц: ${offenders.length}:\n${offenders.slice(0, 6).join('\n')}`,
      ).toEqual([]);
    });
  }
});

// ─── Широкие таблицы прокручиваются и доступны с клавиатуры ─────────────────
// Таблица из легаси-контента на узком экране не влезает и получает
// горизонтальную прокрутку. Прокручиваемая область обязана быть достижима с
// клавиатуры, иначе часть таблицы недоступна тем, кто не пользуется мышью
// (axe: scrollable-region-focusable). Правило появилось после того, как гейт
// поймал это на «Сведениях об образовательной организации».
describe('таблицы в контенте', () => {
  it('каждая таблица лежит в прокручиваемой области с доступом с клавиатуры', () => {
    const offenders: string[] = [];

    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      for (const m of html.matchAll(/<table[\s>]/gi)) {
        const before = html.slice(Math.max(0, m.index! - 220), m.index!);
        const wrapped = /<div[^>]*class="[^"]*table-scroll[^"]*"[^>]*tabindex="0"[^>]*>\s*$/i.test(before);
        if (!wrapped) offenders.push(`${file.replace(dist, '')}: ${before.slice(-60)}<table`);
      }
    }

    expect(
      offenders.slice(0, 5),
      `таблица без прокручиваемой области (${offenders.length}):\n${offenders.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });
});

// ─── Состав соцсетей в подвале ───────────────────────────────────────────────
// Change social-accounts, задача 2.4: две независимые половины, не выводимые
// друг из друга (Решение 2). Ожидания — из контракта, не из social.ts (Решение 3).
// «Присутствует» — внутри подвала; «отсутствует» — по всей странице (задача 2.5).
// Предмет — весь вывод, не одна главная (задача 2.7).
import {
  ACCEPTED_ACCOUNTS,
  retiredMentions,
  socialColumn,
} from './helpers/social-accounts-contract';

describe('соцсети в футере', () => {
  it('принятый состав присутствует в подвале каждой страницы', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      const column = socialColumn(html);
      const page = file.replace(dist, '') || '/';
      if (column.container === null) {
        offenders.push(`${page}: нет колонки «Подписывайтесь»`);
        continue;
      }
      const hrefs = column.links.map((l) => l.href);
      for (const account of ACCEPTED_ACCOUNTS) {
        if (!hrefs.includes(account.href)) {
          offenders.push(`${page}: нет аккаунта ${account.name}`);
        }
      }
    }
    expect(
      offenders.slice(0, 10),
      `принятый состав отсутствует в подвале (${offenders.length}):\n${offenders.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });

  it('снятые сети не вернулись ни на одной странице', () => {
    const offenders: string[] = [];
    for (const file of walkHtml()) {
      const html = readFileSync(file, 'utf-8');
      const page = file.replace(dist, '') || '/';
      for (const m of retiredMentions(html)) {
        offenders.push(`${page}: ${m.name} (${m.where})`);
      }
    }
    expect(
      offenders.slice(0, 10),
      `снятая сеть в выводе (${offenders.length}):\n${offenders.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });
});
