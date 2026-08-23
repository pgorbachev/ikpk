/**
 * Наблюдаемый контракт состава внешних аккаунтов — для проверок change `social-accounts`.
 *
 * ОЖИДАНИЯ ЗАПИСАНЫ ЗДЕСЬ, А НЕ ЧИТАЮТСЯ ИЗ `src/lib/social.ts`, и это требование, а не
 * стиль: спека, Requirement «Ожидания проверки независимы от источника состава». Проверка,
 * читающая ожидания из проверяемого источника, зелена по построению — правка источника
 * сдвигает обе стороны сравнения, и удаление аккаунта перестаёт быть отличимым от
 * изменения требования. Цена решения — два места, которые надо править согласованно;
 * она принята, потому что рассогласование и есть предмет проверки.
 *
 * Модуль НЕ ОБЪЯВЛЯЕТ НИ ОДНОГО КОРНЯ ВЫВОДА. Корень объявляет вызывающий файл проверки,
 * по одному на роль артефакта: иначе один общий импорт дал бы разным проверкам один
 * предмет — ровно то, что запрещает принятая спека `deploy-gating` («проверка, написанная
 * про один из них, SHALL NOT получать на вход другой»). Тот же довод записан в шапке
 * `tests/helpers/walk.ts`.
 *
 * Разбор — деревом (`parse5` через `./dom`), а не регулярками: предмет проверки — место
 * ссылки в документе (внутри подвала или вне его), а приблизительный разбор в этом
 * репозитории уже дважды давал обход гейта.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { parseDocument, textOf, attr, type Element, type ChildNode } from './dom';
import { walkFiles } from './walk';

/** Принятый состав. Перечень, а не вычитание: вычитание не ловит появление пятой сети. */
export const ACCEPTED_ACCOUNTS = [
  { name: 'ВКонтакте', href: 'https://vk.com/clubikpk' },
  { name: 'Youtube', href: 'https://www.youtube.com/user/TheKinesiology' },
  { name: 'Telegram', href: 'https://t.me/ikpk_spb' },
  { name: 'Rutube', href: 'https://rutube.ru/channel/30422569/' },
] as const;

/**
 * Снятые сети. Список НЕ выводится из принятого («всё, чего нет в разрешённом»): такое
 * определение падало бы на любой новой сети, включая ту, которую заказчик завтра попросит
 * добавить, и его пришлось бы ослаблять целиком (design.md, Решение 2).
 *
 * Признак — ХОСТ, а не один конкретный адрес, и это измерение, а не осторожность: в выводе
 * роли `ci` на `main@f114ec698a92d17b3fc0efbd1cff0e46e3cb1f6d` строки `instagram.com` и
 * `facebook.com` встречаются 270 раз каждая и ВСЕ — в подвале, вне подвала ни одной.
 * Значит признак по хосту ложных срабатываний сегодня не даёт, а ловит и НОВЫЙ адрес
 * института в снятой сети, чего перечень двух известных адресов не ловил бы.
 *
 * Граница названа: признак поймает и упоминание хоста в прозе статьи, если такое появится.
 * Это осознанный размен — снятые сети однажды уже вернулись молча.
 */
export const RETIRED_NETWORKS = [
  { name: 'Instagram', host: 'instagram.com' },
  { name: 'Facebook', host: 'facebook.com' },
] as const;

/** Заголовок колонки подвала, в которой живут аккаунты (спека, «Подвал сохраняет раскладку»). */
export const SOCIAL_COLUMN_HEADING = 'Подписывайтесь';

export type AccountName = (typeof ACCEPTED_ACCOUNTS)[number]['name'];

// ─── Реестр применимости марок: сторона ПРОВЕРКИ ────────────────────────────────────────
// Requirement «Решение о применимости марки зафиксировано в машиночитаемом реестре»
// (`design.md`, Решение 18). Реестр — продуктовый файл `web/src/lib/social-marks-registry.ts`,
// который создаёт РЕАЛИЗАЦИЯ; здесь живёт только предикат, читающий его записи, и он
// написан чистой функцией над переданным перечнем — ровно как проверка состава читает
// ожидания из этого модуля, а не из продукта.
//
// Почему предикат отдельно от реестра: спека требует, чтобы автоматическая проверка
// ЧИТАЛА решение владельца, иначе законное исключение («одна сеть осталась текстовой
// ссылкой») неотличимо от потерянной марки. Но сам исход — факт о продукте, а правило его
// прочтения — требование, и смешивать их в одном файле означало бы снова сдвигать обе
// стороны сравнения одной правкой.

/** Исход применимости. БИНАРНЫЙ: третьего значения у поля нет (Решение 18). */
export type MarkOutcome = 'mark' | 'text-link';

/**
 * Запись реестра о сети. Поля названы требованием; `markFileHash` обязателен для исхода
 * `mark`, `themeAssets` — необязательная карта «тема → файл» для тем, где применяется
 * разрешённая правообладателем альтернативная версия марки.
 */
export interface MarkRegistryEntry {
  network: string;
  outcome: MarkOutcome;
  decidedAt: string;
  conditionsSource: string;
  conditionsOutcome: string;
  markFileHash?: string;
  themeAssets?: Record<string, string>;
}

/** Решение по сети: либо названный реестром исход, либо его отсутствие с причиной. */
export type MarkDecision =
  | { outcome: MarkOutcome; entry: MarkRegistryEntry }
  | { outcome: null; why: string };

/**
 * Обязательные поля записи.
 *
 * Спека называет два триггера неполноты прямо («без источника условий или без даты»), но
 * перечисляет полный состав полей, и запись без любого перечисленного поля требованию не
 * удовлетворяет тоже. Предикат взят по ВСЕМУ перечню намеренно: более узкий принимал бы
 * запись с исходом `mark` без `markFileHash`, а тогда у сверки «файл марки совпадает с
 * первоисточником» нет второго операнда и она сравнивает файл сам с собой (Решение 17).
 */
function missingFields(entry: MarkRegistryEntry): string[] {
  const required: Array<keyof MarkRegistryEntry> = [
    'network',
    'outcome',
    'decidedAt',
    'conditionsSource',
    'conditionsOutcome',
  ];
  if (entry.outcome === 'mark') required.push('markFileHash');
  return required.filter((field) => {
    const value = entry[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * Исход для сети по реестру.
 *
 * `outcome: null` — «решения нет», и по спеке это ОДНО состояние с тремя входами: записи о
 * сети нет вовсе, запись неполна, реестр не отдаёт перечня. Спека сама их приравнивает
 * («отсутствие записи о сети равнозначно неполной записи»), поэтому и предикат один, а
 * причина остаётся в `why` для сообщения проверки.
 *
 * Две записи об одной сети — тоже «решения нет»: спека говорит о ЗАПИСИ о сети в
 * единственном числе, а проверка, молча берущая первую из двух, выбирала бы за читателя.
 */
export function markDecision(registry: unknown, network: string): MarkDecision {
  if (!Array.isArray(registry)) {
    return { outcome: null, why: 'реестр применимости не отдаёт перечня записей' };
  }
  const entries = (registry as MarkRegistryEntry[]).filter((e) => e?.network === network);
  if (entries.length === 0) return { outcome: null, why: 'записи о сети в реестре нет' };
  if (entries.length > 1) {
    return { outcome: null, why: `о сети ${entries.length} записи — какая главная, реестр не говорит` };
  }
  const entry = entries[0]!;
  if (entry.outcome !== 'mark' && entry.outcome !== 'text-link') {
    return { outcome: null, why: `исход '${String(entry.outcome)}' не из двух допустимых значений` };
  }
  const missing = missingFields(entry);
  if (missing.length > 0) {
    return { outcome: null, why: `запись неполна: нет ${missing.join(', ')}` };
  }
  return { outcome: entry.outcome, entry };
}

/**
 * Сети, обязанные нести марку: те, для которых реестр НЕ называет исход `text-link`.
 *
 * Формулировка ровно как в сценарии «марка сети показана» после его сужения. Сеть без
 * решения попадает СЮДА: реестр для неё `text-link` не называет, значит требование о марке
 * действует. Отдельно от этого её подача не считается выполненной — это `networksWithoutDecision`.
 */
export function networksRequiringMark(registry: unknown, networks: readonly string[]): string[] {
  return networks.filter((n) => markDecision(registry, n).outcome !== 'text-link');
}

/** Сети, у которых решения нет: их подача не считается выполненной (спека, оба Requirement). */
export function networksWithoutDecision(
  registry: unknown,
  networks: readonly string[],
): Array<{ network: string; why: string }> {
  const out: Array<{ network: string; why: string }> = [];
  for (const network of networks) {
    const decision = markDecision(registry, network);
    if (decision.outcome === null) out.push({ network, why: decision.why });
  }
  return out;
}

/**
 * Порог полноты: исход `text-link` более чем у одной сети — подача НЕ выполнена и
 * возвращается в change. Возвращает перечень таких сетей, когда порог перейдён, и пустой
 * перечень, когда нет: одна текстовая ссылка требование не нарушает.
 */
export function textLinkOverflow(registry: unknown, networks: readonly string[]): string[] {
  const textual = networks.filter((n) => markDecision(registry, n).outcome === 'text-link');
  return textual.length > 1 ? textual : [];
}

function childElements(node: unknown): Element[] {
  const n = node as { childNodes?: ChildNode[] };
  return (n.childNodes ?? []).filter((c): c is Element => 'tagName' in c);
}

/**
 * Элементы роли `contentinfo`: `<footer>`, не вложенный в секционирующий контент, плюс
 * явный `role="contentinfo"`. Признак — по правилу ARIA, а не по имени CSS-класса: класс
 * — деталь реализации, и гейт, отбирающий по классу, переименование класса читает как
 * исчезновение подвала.
 */
export function contentInfoElements(html: string): Element[] {
  const SECTIONING = new Set(['article', 'aside', 'main', 'nav', 'section']);
  const found: Element[] = [];
  const visit = (node: unknown, sectioned: boolean): void => {
    for (const el of childElements(node)) {
      const tag = el.tagName;
      const role = attr(el, 'role');
      if (role === 'contentinfo' || (tag === 'footer' && !sectioned)) found.push(el);
      visit(el, sectioned || SECTIONING.has(tag));
    }
  };
  visit(parseDocument(html), false);
  return found;
}

export interface SocialColumn {
  /** Контейнер колонки — родитель заголовка «Подписывайтесь». `null`, если заголовка нет. */
  container: Element | null;
  /** Ссылки колонки: href и доступный видимый текст. */
  links: Array<{ href: string; text: string }>;
}

/**
 * Колонка аккаунтов внутри подвала.
 *
 * Отбор идёт по ЗАГОЛОВКУ колонки, а не по имени CSS-класса и не по списку `<ul>`: колонка
 * названа самим требованием о раскладке, а разметка внутри неё — деталь реализации,
 * которую замена текста иконками как раз и меняет (список может стать `<div>`). Границей
 * колонки взят РОДИТЕЛЬ заголовка: он остаётся тем же элементом при любой перестройке
 * внутренностей.
 */
export function socialColumn(html: string): SocialColumn {
  for (const footer of contentInfoElements(html)) {
    const stack: Element[] = [footer];
    while (stack.length) {
      const el = stack.pop()!;
      for (const child of childElements(el)) {
        if (/^h[1-6]$/.test(child.tagName) && textOf(child) === SOCIAL_COLUMN_HEADING) {
          const links = [...collectLinks(el)];
          return { container: el, links };
        }
        stack.push(child);
      }
    }
  }
  return { container: null, links: [] };
}

function* collectLinks(root: Element): Generator<{ href: string; text: string }> {
  for (const child of childElements(root)) {
    if (child.tagName === 'a') {
      const href = attr(child, 'href');
      if (href !== null) yield { href, text: textOf(child) };
    }
    yield* collectLinks(child);
  }
}

/** Все ссылки документа — предмет половины «отсутствует»: она мерится по ВСЕЙ странице. */
export function allLinks(html: string): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    for (const el of childElements(node)) {
      if (el.tagName === 'a') {
        const href = attr(el, 'href');
        if (href !== null) out.push(href);
      }
      visit(el);
    }
  };
  visit(parseDocument(html));
  return out;
}

/**
 * Упоминания снятых сетей на странице: и ссылками, и любым другим вхождением хоста.
 *
 * Второе не педантизм: адрес аккаунта может уехать в `sameAs` структурированных данных или
 * в `<meta>`, и проверка только по `<a href>` объявила бы такую страницу чистой.
 */
export function retiredMentions(html: string): Array<{ name: string; where: 'ссылка' | 'текст вывода' }> {
  const links = allLinks(html);
  const out: Array<{ name: string; where: 'ссылка' | 'текст вывода' }> = [];
  for (const { name, host } of RETIRED_NETWORKS) {
    // Хост сверяется целиком или как поддомен, а не суффиксом строки: `notinstagram.com`
    // суффиксную сверку прошёл бы и дал ложное расхождение.
    const isHost = (h: string): boolean => h === host || h.endsWith(`.${host}`);
    if (links.some((href) => isHost(hostOf(href)))) out.push({ name, where: 'ссылка' });
    else if (html.includes(host)) out.push({ name, where: 'текст вывода' });
  }
  return out;
}

function hostOf(href: string): string {
  try {
    return new URL(href, 'https://ikpk.su').host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Страницы вывода по корню. ПАДАЕТ на отсутствующем корне, не-каталоге и пустом перечне:
 * проверка, лишившаяся предмета, считается непройденной, а не пройденной (спека,
 * сценарий «перечень страниц пуст»; принятая спека `deploy-gating`).
 */
export function outputPages(root: string, buildCommand: string): string[] {
  const fail = (what: string): never => {
    throw new Error(
      `предмета проверки нет: ${what} — '${root}'. Пустой вывод считается «не выполнено», ` +
        `а не «нарушений нет». Собрать вывод: ${buildCommand}`,
    );
  };
  if (!existsSync(root)) fail('каталога вывода нет');
  if (!statSync(root).isDirectory()) fail('путь вывода — не каталог');
  const pages = [...walkFiles(root, ['.html'])];
  if (pages.length === 0) fail('html-страниц в выводе нет');
  return pages;
}

export const ARTIFACT_ROLE_ATTR = 'data-payment-role';
/** Страница, на которой артефакт объявляет свою роль машинно. */
export const ROLE_DECLARATION_PAGE = join('oplata', 'index.html');

/**
 * Роль артефакта, прочитанная ИЗ САМОГО АРТЕФАКТА.
 *
 * Отсутствие объявления — НЕПРОЙДЕННАЯ проверка, а не «предмета нет»: потерянная роль
 * иначе читалась бы как разрешение пропустить проверку (спека, сценарий «роль артефакта не
 * объявлена»; принятая спека `deploy-gating`, сценарий «роль не объявлена»).
 *
 * Своего объявления роли для соцсетей не заводится намеренно: два объявления роли у одного
 * артефакта разошлись бы, и было бы неясно, какое главное.
 */
export function artifactRole(root: string): string {
  const file = join(root, ROLE_DECLARATION_PAGE);
  if (!existsSync(file)) {
    throw new Error(
      `артефакт '${root}' не объявляет роль: страницы ${ROLE_DECLARATION_PAGE} в выводе нет — ` +
        'проверка не пройдена, а не «предмета нет»',
    );
  }
  const html = readFileSync(file, 'utf-8');
  const values = [
    ...new Set([...html.matchAll(new RegExp(`\\b${ARTIFACT_ROLE_ATTR}="([^"]*)"`, 'gi'))].map((m) => m[1])),
  ];
  if (values.length === 0) {
    throw new Error(
      `артефакт '${root}' не объявляет ${ARTIFACT_ROLE_ATTR} на /oplata — проверка не пройдена`,
    );
  }
  if (values.length > 1) {
    throw new Error(`артефакт '${root}' объявляет несколько ролей сразу: ${values.join(', ')}`);
  }
  return values[0]!;
}

/**
 * Набор проверок состава для ОДНОЙ роли артефакта.
 *
 * Тело общее, корень и ожидаемая роль — параметры вызывающего файла. Требование спеки —
 * «состав SHALL быть проверен для каждой роли артефакта, собираемой обязательным
 * прогоном, и каждой проверке SHALL подаваться артефакт её собственной роли», поэтому
 * файлов проверки столько же, сколько ролей, а не один с тремя корнями.
 */
export function socialAccountsSuite(options: {
  role: string;
  root: string;
  buildCommand: string;
}): void {
  const { role, root, buildCommand } = options;

  describe(`состав внешних аккаунтов: артефакт роли ${role}`, () => {
    it('артефакт объявляет свою роль, и она ожидаемая для этой проверки', () => {
      expect(
        artifactRole(root),
        `проверке роли ${role} подан артефакт другой роли — предмет подменён`,
      ).toBe(role);
    });

    it('в подвале каждой страницы ровно принятый состав', () => {
      const pages = outputPages(root, buildCommand);
      const offenders: string[] = [];
      for (const file of pages) {
        const html = readFileSync(file, 'utf-8');
        const column = socialColumn(html);
        const page = file.slice(root.length) || '/';
        if (column.container === null) {
          offenders.push(`${page}: в подвале нет колонки «${SOCIAL_COLUMN_HEADING}»`);
          continue;
        }
        const hrefs = column.links.map((l) => l.href);
        const missing = ACCEPTED_ACCOUNTS.filter((a) => !hrefs.includes(a.href));
        const extra = hrefs.filter((h) => !ACCEPTED_ACCOUNTS.some((a) => a.href === h));
        for (const m of missing) offenders.push(`${page}: нет аккаунта ${m.name} (${m.href})`);
        for (const e of extra) offenders.push(`${page}: в колонке лишняя ссылка ${e}`);
      }
      expect(
        offenders.slice(0, 10),
        `подвал не даёт принятого состава (${offenders.length} расхождений на ${pages.length} страницах):\n${offenders
          .slice(0, 10)
          .join('\n')}`,
      ).toEqual([]);
    });

    it('снятых сетей нет ни на одной странице вывода', () => {
      const pages = outputPages(root, buildCommand);
      const offenders: string[] = [];
      for (const file of pages) {
        const html = readFileSync(file, 'utf-8');
        const page = file.slice(root.length) || '/';
        for (const m of retiredMentions(html)) {
          offenders.push(`${page}: вернулась ${m.name} (${m.where})`);
        }
      }
      expect(
        offenders.slice(0, 10),
        `снятая сеть присутствует в выводе (${offenders.length} вхождений на ${pages.length} страницах):\n${offenders
          .slice(0, 10)
          .join('\n')}`,
      ).toEqual([]);
    });
  });
}
