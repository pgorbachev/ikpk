import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Гейт по ТЕКСТУ генерируемой конфигурации раздачи.
 *
 * Change `serving-cache-headers`, capability `static-serving`. Требование
 * «Политика проверяется по тексту генерируемой конфигурации» задаёт предмет: текст
 * vhost, который порождает `scripts/bootstrap-vps.sh` — единственный носитель
 * конфигурации раздачи в репозитории (файла конфигурации нет, каталога `infra/` нет).
 *
 * Что здесь НЕ проверяется и почему. Заголовки `Cache-Control`/`Content-Encoding` в
 * ответе, коды 301/404 и «шрифт взят из кеша» — это поведение сервера, а не текста:
 * nginx не является зависимостью проекта и в тестах не поднимается (design.md,
 * Non-Goals). Спека требует для них отдельного свидетельства с живой раздачи
 * (требование «Действие политики на живой раздаче подтверждается свидетельством»),
 * способ — раздел 5 `tasks.md`. Полный перечень сценариев без автоматической проверки —
 * в конце файла, в блоке СЦЕНАРИИ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ.
 *
 * Проверка обязана различать «нарушений нет» и «проверить не удалось»: если тела
 * heredoc'а нет, оно пусто или неразбираемо — тесты падают с меткой
 * `ПРОВЕРИТЬ НЕ УДАЛОСЬ`, а не проходят на пустом множестве.
 *
 * НАЗВАННОЕ ПЕРЕСЕЧЕНИЕ с существующей проверкой (tasks.md 2.9):
 * `web/tests/repo-hygiene.test.ts` («конфигурация стенда подключает файл редиректов»)
 * уже утверждает наличие `include` файла редиректов — но по ВСЕМУ тексту скрипта.
 * Здесь то же утверждается внутри heredoc'а vhost, то есть строже: `include`,
 * оказавшийся в инструкции оператору (`scripts/bootstrap-vps.sh`, блок EXISTING), эту
 * проверку не удовлетворит. Ответы обеих обязаны совпадать. Это не дубль — не удаляйте
 * более строгую.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const BOOTSTRAP_REL = 'scripts/bootstrap-vps.sh';
const REDIRECTS_REL = 'deploy/nginx-redirects.conf';

/** Разделитель heredoc'а, порождающего vhost. Переименование = предмет исчез. */
const HEREDOC = 'NGINX';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PAGES = 'public, max-age=0, must-revalidate';

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

type Directive = { name: string; args: string[]; raw: string };
type Block = {
  name: string;
  args: string[];
  header: string;
  directives: Directive[];
  children: Block[];
};

type LocKind = 'exact' | 'prefix' | 'prefix-priority' | 'regex' | 'regex-i' | 'named';
type Loc = { block: Block; kind: LocKind; pattern: string; order: number };

/**
 * Строки-комментарии и хвостовые комментарии выбрасываются ДО поиска директив.
 * Приём и его происхождение — `web/tests/repo-hygiene.test.ts:118-130`: та проверка
 * искала подстроку по всему тексту и не ловила закомментированный `include`, потому что
 * имя файла оставалось в комментарии рядом. Здесь та же природа дефекта:
 * `scripts/bootstrap-vps.sh` печатает оператору инструкцию с директивами текстом.
 * В отличие от прототипа режем не только строки, начинающиеся с `#`, но и хвост после
 * незакавыченного `#` — иначе `add_header ...; # так было раньше` считался бы кодом.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i += 1;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Разбивает текст директивы на аргументы, снимая кавычки: значение политики закавычено. */
function splitArgs(source: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\' && i + 1 < source.length) {
        cur += source[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== '' || quoted) {
        out.push(cur);
        cur = '';
        quoted = false;
      }
      continue;
    }
    cur += c;
  }
  if (cur !== '' || quoted) out.push(cur);
  return out;
}

/**
 * Разбирает текст конфигурации на дерево блоков. `{`, `}` и `;` внутри кавычек
 * структурой не считаются. Неразбираемый текст — это «проверить не удалось», поэтому
 * непарные скобки и директива без `;` роняют проверку, а не молча теряются.
 */
function parseConfig(text: string): Block {
  const root: Block = { name: '', args: [], header: '<heredoc>', directives: [], children: [] };
  const stack: Block[] = [root];
  let buf = '';
  let quote: string | null = null;

  const flush = (): void => {
    const raw = buf.trim();
    buf = '';
    if (!raw) return;
    const args = splitArgs(raw);
    stack[stack.length - 1].directives.push({ name: args[0] ?? '', args: args.slice(1), raw });
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '{') {
      const header = buf.trim();
      buf = '';
      const args = splitArgs(header);
      const block: Block = {
        name: args[0] ?? '',
        args: args.slice(1),
        header,
        directives: [],
        children: [],
      };
      stack[stack.length - 1].children.push(block);
      stack.push(block);
      continue;
    }
    if (c === '}') {
      flush();
      if (stack.length === 1) {
        throw new Error(
          `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} закрывающая «}» без открывающей — ` +
            'текст конфигурации неразбираем',
        );
      }
      stack.pop();
      continue;
    }
    if (c === ';') {
      flush();
      continue;
    }
    buf += c;
  }

  if (buf.trim()) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} директива без завершающей «;»: ` +
        `«${buf.trim().slice(0, 80)}»`,
    );
  }
  if (stack.length !== 1) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} незакрытый блок ` +
        `«${stack[stack.length - 1].header}» — текст конфигурации неразбираем`,
    );
  }
  return root;
}

function classifyLocation(block: Block, order: number): Loc {
  const a = block.args;
  if (a.length === 2) {
    const [mod, pattern] = a;
    if (mod === '=') return { block, kind: 'exact', pattern, order };
    if (mod === '^~') return { block, kind: 'prefix-priority', pattern, order };
    if (mod === '~') return { block, kind: 'regex', pattern, order };
    if (mod === '~*') return { block, kind: 'regex-i', pattern, order };
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: неизвестный модификатор location «${mod}» в «${block.header}» — ` +
        'выбор обработчика воспроизвести нельзя',
    );
  }
  if (a.length === 1) {
    if (a[0].startsWith('@')) return { block, kind: 'named', pattern: a[0], order };
    return { block, kind: 'prefix', pattern: a[0], order };
  }
  throw new Error(
    `ПРОВЕРИТЬ НЕ УДАЛОСЬ: не разобран location «${block.header}» — ` +
      'выбор обработчика воспроизвести нельзя',
  );
}

function locRegExp(loc: Loc): RegExp {
  try {
    return new RegExp(loc.pattern, loc.kind === 'regex-i' ? 'i' : '');
  } catch (err) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: регулярное выражение location «${loc.pattern}» не компилируется ` +
        'движком JS — сопоставление адресов воспроизвести нельзя',
      { cause: err },
    );
  }
}

/**
 * Воспроизводит выбор обработчика в nginx: точное совпадение (и поиск прекращается) →
 * самый длинный префикс с `^~` (и регулярные выражения не рассматриваются) →
 * регулярные выражения в порядке объявления → самый длинный обычный префикс.
 * Порядок здесь несущий: на нём держится безопасность адресного контракта
 * (design.md, Решение 5).
 */
function matchLocation(locs: Loc[], uri: string): Loc | null {
  const exact = locs.find((l) => l.kind === 'exact' && l.pattern === uri);
  if (exact) return exact;

  const prefixes = locs
    .filter(
      (l) => (l.kind === 'prefix' || l.kind === 'prefix-priority') && uri.startsWith(l.pattern),
    )
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const longest = prefixes[0];
  if (longest && longest.kind === 'prefix-priority') return longest;

  const regexes = locs
    .filter((l) => l.kind === 'regex' || l.kind === 'regex-i')
    .sort((a, b) => a.order - b.order);
  for (const l of regexes) {
    if (locRegExp(l).test(uri)) return l;
  }
  return longest ?? null;
}

function addHeaders(block: Block): Directive[] {
  return block.directives.filter((d) => d.name === 'add_header');
}

function cacheControls(block: Block): Directive[] {
  return addHeaders(block).filter((d) => d.args[0] === 'Cache-Control');
}

type CacheDecl = { value: string; always: boolean; raw: string };

function readCacheDecl(d: Directive, where: string): CacheDecl {
  if (d.args.length < 2 || d.args.length > 3 || (d.args.length === 3 && d.args[2] !== 'always')) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в «${where}» директива «${d.raw}» не разбирается как ` +
        'add_header Cache-Control "<значение>" [always] — значение не закавычено ' +
        'или аргументов не то число',
    );
  }
  return { value: d.args[1], always: d.args[2] === 'always', raw: d.raw };
}

/**
 * Откуда придёт `Cache-Control` для адреса. Наследование в nginx НЕ поблочно-складывающееся:
 * блок, объявивший хотя бы один `add_header`, теряет заголовки внешнего уровня целиком;
 * не объявивший ни одного — получает их целиком (design.md, Решение 3). Поэтому решает
 * наличие любого `add_header`, а не именно `Cache-Control`.
 */
type Resolution =
  | { source: 'location'; where: string; decls: CacheDecl[] }
  | { source: 'server'; where: string; decls: CacheDecl[] }
  // `lost-by-override` — обработчик объявил свои add_header и тем потерял серверные, а
  // собственного Cache-Control не объявил. `not-declared` — Cache-Control не объявлен
  // нигде. Исходы различаются: первый — дефект конфигурации, второй — её отсутствие.
  | { source: 'absent'; where: string; reason: 'lost-by-override' | 'not-declared'; decls: [] };

function resolveCacheControl(cfgv: Parsed, uri: string): Resolution {
  const loc = matchLocation(cfgv.locs, uri);
  if (loc && addHeaders(loc.block).length > 0) {
    const where = `location ${loc.block.args.join(' ')}`;
    const decls = cacheControls(loc.block).map((d) => readCacheDecl(d, where));
    if (decls.length === 0) {
      return { source: 'absent', where, reason: 'lost-by-override', decls: [] };
    }
    return { source: 'location', where, decls };
  }
  const decls = cacheControls(cfgv.server).map((d) => readCacheDecl(d, 'server'));
  if (decls.length === 0) {
    return { source: 'absent', where: 'server', reason: 'not-declared', decls: [] };
  }
  return { source: 'server', where: 'server', decls };
}

/** Почему по адресу не придёт Cache-Control — сообщение под фактическую причину. */
function absentWhy(r: Resolution & { source: 'absent' }, uri: string): string {
  return r.reason === 'lost-by-override'
    ? `по адресу ${uri} Cache-Control не придёт вовсе: обработчик «${r.where}» объявил свои ` +
        'add_header и тем потерял серверные, а собственного Cache-Control не объявил ' +
        '(nginx не складывает add_header по уровням)'
    : `по адресу ${uri} Cache-Control не придёт вовсе: он не объявлен ни в обработчике ` +
        `«${r.where}», ни на уровне server`;
}

// ---------------------------------------------------------------------------
// Извлечение предмета
// ---------------------------------------------------------------------------

type Parsed = { text: string; root: Block; server: Block; locs: Loc[] };

function extractVhostText(): string {
  const script = readFileSync(join(ROOT, BOOTSTRAP_REL), 'utf-8');
  const lines = script.split('\n');
  const openRe = new RegExp(`<<-?\\s*['"]?${HEREDOC}['"]?\\s*$`);
  const open = lines.findIndex((l) => openRe.test(l));
  if (open === -1) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в ${BOOTSTRAP_REL} не найдено открытие heredoc'а <<${HEREDOC}. ` +
        'Предмет проверки — текст порождаемого vhost — отсутствует или разделитель ' +
        'переименован. Пустое множество директив успехом не считается.',
    );
  }
  const rest = lines.slice(open + 1);
  const close = rest.findIndex((l) => l.trim() === HEREDOC);
  if (close === -1) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в ${BOOTSTRAP_REL} не найден закрывающий разделитель ${HEREDOC} — ` +
        'тело vhost не ограничено, разбирать нечего.',
    );
  }
  // Предмет требования — текст, который получит nginx, к нему и приводим. heredoc НЕ
  // закавычен, поэтому bash разворачивает `\$` в `$`, а `${ИМЯ}` — в значение переменной
  // окружения. Значения зависят от окружения запуска (`WEB_ROOT`, `SITE_NAME`, `DOMAIN`),
  // а требования этой capability от них не зависят, поэтому подстановка сводится к имени:
  // `${WEB_ROOT}` → `$WEB_ROOT`. Фигурные скобки убрать обязательно — иначе разборщик
  // примет `${` за начало блока (в синтаксисе nginx `${…}` не встречается: его переменные
  // пишутся как `$имя`).
  return rest
    .slice(0, close)
    .join('\n')
    .replace(/\\\$/g, '$')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');
}

let memo: Parsed | undefined;
let memoError: Error | undefined;

/** Мемоизировано и лениво: сбой предмета должен падать по ИМЕНИ теста, а не в загрузке модуля. */
function cfg(): Parsed {
  if (memo) return memo;
  if (memoError) throw memoError;
  try {
    const text = stripComments(extractVhostText());
    if (!/\S/.test(text)) {
      throw new Error(
        `ПРОВЕРИТЬ НЕ УДАЛОСЬ: тело heredoc'а ${HEREDOC} пусто после сброса комментариев — ` +
          'исполняемых директив в конфигурации нет.',
      );
    }
    const root = parseConfig(text);
    const servers = root.children.filter((b) => b.name === 'server');
    if (servers.length !== 1) {
      throw new Error(
        `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} ожидался ровно один блок server, ` +
          `найдено ${servers.length}.`,
      );
    }
    const server = servers[0];
    if (server.directives.length === 0 && server.children.length === 0) {
      throw new Error(
        `ПРОВЕРИТЬ НЕ УДАЛОСЬ: блок server пуст — проверять политику не на чем.`,
      );
    }
    const locs = server.children
      .filter((b) => b.name === 'location')
      .map((b, i) => classifyLocation(b, i));
    memo = { text, root, server, locs };
    return memo;
  } catch (err) {
    memoError = err as Error;
    throw memoError;
  }
}

function redirectRules(): Block[] {
  const text = readFileSync(join(ROOT, REDIRECTS_REL), 'utf-8');
  return parseConfig(stripComments(text)).children.filter((b) => b.name === 'location');
}

function redirectAddresses(): string[] {
  return redirectRules()
    .filter((b) => b.args.length === 2 && b.args[0] === '=')
    .map((b) => b.args[1]);
}

// ---------------------------------------------------------------------------
// Классы адресов из спеки
// ---------------------------------------------------------------------------

/** Классы со СВОИМ сроком: значение обязано быть объявлено в правиле самого класса. */
const OWN_TTL_CLASSES = [
  {
    name: '/_astro/ (хеш содержимого в имени)',
    uris: ['/_astro/CtaBand.CeDd4XWy.css', '/_astro/global.BgxQ8uu7.css'],
    value: IMMUTABLE,
    immutable: true,
  },
  {
    name: 'данные поиска .pf_fragment/.pf_index/.pf_meta (хеш в имени)',
    uris: [
      '/pagefind/fragment/ru_129b2ce.pf_fragment',
      '/pagefind/index/ru_22aa6c8.pf_index',
      '/pagefind/pagefind.ru_206ebec66e.pf_meta',
    ],
    value: IMMUTABLE,
    immutable: true,
  },
  {
    name: '/fonts/',
    uris: ['/fonts/inter-latin.woff2', '/fonts/inter-cyrillic.woff2'],
    value: 'public, max-age=2592000',
    immutable: false,
  },
  {
    name: 'favicon.* в корне',
    uris: ['/favicon.ico', '/favicon.svg'],
    value: 'public, max-age=86400',
    immutable: false,
  },
  {
    name: 'sitemap*.xml в корне',
    uris: ['/sitemap-index.xml', '/sitemap-0.xml'],
    value: 'public, max-age=3600',
    immutable: false,
  },
] as const;

/**
 * Классы БЕЗ своего срока: политика страниц. Своего правила они не требуют — важно
 * значение, которое доедет до ответа. Загрузчик поиска стоит здесь намеренно: правило,
 * записанное по каталогу `/pagefind/` вместо расширения `.pf_*`, накрыло бы манифест
 * `pagefind-entry.json` годовым сроком, и поиск после выкладки перестал бы работать.
 */
const DEFAULT_CLASSES = [
  { name: 'главная /', uris: ['/'] },
  { name: 'страница без расширения и без слэша', uris: ['/kontakty', '/statyi/nekaya-statya'] },
  { name: 'страница /sitemap (HTML для человека, не XML)', uris: ['/sitemap'] },
  { name: 'страница ошибки прямым запросом /404.html', uris: ['/404.html'] },
  {
    name: 'загрузчик и манифест поиска (постоянные имена)',
    uris: [
      '/pagefind/pagefind-entry.json',
      '/pagefind/pagefind-ui.js',
      '/pagefind/pagefind.js',
      '/pagefind/wasm.ru.pagefind',
    ],
  },
  {
    name: 'вне перечисленных классов',
    uris: ['/og-image.png', '/robots.txt', '/media/nekiy-fayl.jpg'],
  },
] as const;

// ---------------------------------------------------------------------------
// Класс корневых `.svg` (tasks.md 2.13 «Красные тесты класса корневых .svg»;
// реализация — задача 3.12, к моменту написания этих проверок не сделана)
// ---------------------------------------------------------------------------

/**
 * Представители класса. Адреса взяты из спеки (сценарий «Векторная графика в корне
 * сайта»); на зашитые литералы одной сборки распространяется уже зарегистрированный
 * долг TD-26, отдельным дефектом это здесь не является.
 */
const ROOT_SVG_URIS = ['/hero-main.svg', '/logo-wordmark.svg', '/logo-icon.svg'] as const;

/**
 * Адрес, который подходит ТОЛЬКО под правило класса `favicon.` и ни под одно правило
 * корневых `.svg`. Нужен не как представитель класса favicon (он уже есть в
 * OWN_TTL_CLASSES), а как способ опознать правило favicon НЕ по порядку объявления:
 * опознание по порядку сделало бы проверку порядка тавтологией — она утверждала бы
 * порядок, найдя правила по этому же порядку.
 */
const FAVICON_ONLY_URI = '/favicon.ico';

/**
 * `.svg` вне корня сайта: два сегмента пути. Класс задан корнем намеренно (спека,
 * сценарий «Векторная графика вне корня сайта»), поэтому этот адрес обязан получать
 * политику страниц, а не суточный срок.
 */
const NON_ROOT_SVG_URI = '/media/nekaya-kartinka.svg';

const ROOT_SVG_VALUE = 'public, max-age=86400';

/** Все правила-регулярные-выражения, под которые подходит адрес, в порядке объявления. */
function regexLocsMatching(cfgv: Parsed, uri: string): Loc[] {
  return cfgv.locs
    .filter((l) => (l.kind === 'regex' || l.kind === 'regex-i') && locRegExp(l).test(uri))
    .sort((a, b) => a.order - b.order);
}

/**
 * Правило, под которое подходит адрес, — при условии, что оно ровно одно. Ноль правил и
 * два правила — разные исходы, и оба «проверить не удалось», а не «нарушений нет»: в
 * первом случае предмета нет, во втором адрес не опознаёт правило однозначно, то есть
 * утверждать о порядке или значении нечего.
 */
function soleRegexLocFor(cfgv: Parsed, uri: string, what: string): Loc {
  const found = regexLocsMatching(cfgv, uri);
  if (found.length === 0) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} нет правила ${what} — под адрес ` +
        `${uri} не подходит ни одно регулярное выражение location. Отсутствие правила ` +
        'успехом не считается: утверждать о его значении и о порядке объявления нечего.',
    );
  }
  if (found.length > 1) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: под адрес ${uri} подходит ${found.length} правил ` +
        `(${found.map((l) => l.block.header).join(' | ')}) — правило ${what} по нему не ` +
        'опознаётся однозначно, поэтому ни значение, ни порядок утверждать нельзя.',
    );
  }
  return found[0];
}

const REQUIRED_GZIP_GROUPS = [
  { what: 'CSS', accept: ['text/css'] },
  {
    what: 'JavaScript',
    // Ровно два написания (tasks.md 2.13): `application/x-javascript`, сегодня стоящий в
    // accept третьим, обязательным становиться не должен — требование называет для
    // JavaScript только application/javascript и text/javascript.
    accept: ['application/javascript', 'text/javascript'],
  },
  { what: 'SVG', accept: ['image/svg+xml'] },
  // Обязательны ОБА написания (tasks.md 2.13, ужесточение относительно предыдущей
  // ревизии спеки): mime.types в nginx Ubuntu отображает `.xml` в `text/xml`. Перечень с
  // одним `application/xml` карту сайта сжимать не будет — теперь это ловит сам текст
  // (проверка ниже требует каждую строку из accept, а не любую из них). Живая раздача
  // (раздел 5, шаг 5.4) остаётся обязательной: фактический тип задаёт таблица типов
  // nginx, а не наш конфиг, и обновление пакета меняет её без нашего участия.
  { what: 'XML', accept: ['application/xml', 'text/xml'] },
  { what: 'JSON', accept: ['application/json'] },
  { what: 'обычный текст', accept: ['text/plain'] },
] as const;

/** Уже сжатое содержимое: повторное сжатие тратит процессор и ответ не уменьшает. */
const FORBIDDEN_COMPRESSED_TYPES = [
  'font/woff2',
  'application/font-woff2',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-bzip2',
];

/**
 * Пустого перечня эта функция не возвращает: утверждения «в перечне нет text/html»,
 * «нет woff2», «нет application/octet-stream» на отсутствующем перечне вакуумны — они
 * были бы зелёными ровно там, где сжатие настроено хуже всего.
 */
function gzipTypes(cfgv: Parsed): string[] {
  const decls = cfgv.server.directives.filter((d) => d.name === 'gzip_types');
  if (decls.length > 1) {
    throw new Error(
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: gzip_types объявлен в блоке server ${decls.length} раза — ` +
        'какой перечень действует, из текста не следует',
    );
  }
  const types = decls[0]?.args ?? [];
  if (types.length === 0) {
    throw new Error(
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: gzip_types в блоке server не задан, перечня сжимаемых типов ' +
        'нет. Умолчание nginx — только text/html: при включённом сжатии и незаданном ' +
        'перечне таблицы стилей и поисковый скрипт едут несжатыми, а проверка «сжатие ' +
        'включено» на HTML остаётся зелёной.',
    );
  }
  return types;
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('раздача: кеш-политика и сжатие в тексте генерируемого vhost', () => {
  // 2.1 — ветка вакуума. Мутация 4.7 (переименовать разделитель heredoc) обязана
  // ронять именно её, и с меткой «ПРОВЕРИТЬ НЕ УДАЛОСЬ».
  it('2.1 предмет проверки существует: тело heredoc NGINX найдено, непусто и разбирается', () => {
    const parsed = cfg();
    expect(
      parsed.server.directives.length + parsed.server.children.length,
      'блок server не содержит директив — проверять политику не на чем',
    ).toBeGreaterThan(0);
    // Разбор состоялся: список location получен (пустой список — законное состояние
    // текста, но само получение списка доказывает, что предмет разобран).
    expect(Array.isArray(parsed.locs)).toBe(true);
  });

  // 2.2 — значения дословно. Мутации 4.1 (удалить правило), 4.2 (max-age без immutable),
  // 4.3 (закомментировать политику страниц).
  it.each(OWN_TTL_CLASSES)('2.2 класс $name отдаётся с заданным значением', (klass) => {
    for (const uri of klass.uris) {
      const r = resolveCacheControl(cfg(), uri);
      expect(r.source, r.source === 'absent' ? absentWhy(r, uri) : '').not.toBe('absent');
      expect(
        r.decls.length,
        `по адресу ${uri} в «${r.where}» объявлений Cache-Control ${r.decls.length}, а не одно`,
      ).toBe(1);
      expect(
        r.decls[0].value,
        `класс «${klass.name}»: по адресу ${uri} действует значение из «${r.where}»`,
      ).toBe(klass.value);
    }
  });

  // 2.3 — различающая проверка. Мутация 4.10 (перенести строку в блок server) оставляет
  // все значения в тексте heredoc'а, поэтому проверка «значение встречается в файле»
  // остаётся зелёной, а эта краснеет.
  it.each(OWN_TTL_CLASSES)(
    '2.3 класс $name объявляет своё значение в СВОЁМ правиле, а не наследует его',
    (klass) => {
      for (const uri of klass.uris) {
        const r = resolveCacheControl(cfg(), uri);
        expect(
          r.source,
          `класс «${klass.name}»: по адресу ${uri} значение приходит из «${r.where}». ` +
            'Класс со своим сроком обязан объявлять его в собственном правиле — иначе ' +
            'проверка не отличает верную конфигурацию от перепутанной',
        ).toBe('location');
      }
    },
  );

  it.each(DEFAULT_CLASSES)('2.2 класс $name отдаётся с политикой страниц', (klass) => {
    for (const uri of klass.uris) {
      const r = resolveCacheControl(cfg(), uri);
      expect(r.source, r.source === 'absent' ? absentWhy(r, uri) : '').not.toBe('absent');
      expect(
        r.decls.length,
        `по адресу ${uri} в «${r.where}» объявлений Cache-Control ${r.decls.length}, а не одно`,
      ).toBe(1);
      expect(
        r.decls[0].value,
        `класс «${klass.name}»: по адресу ${uri} действует значение из «${r.where}». ` +
          'Долгий срок адресам с постоянными именами не назначается: кеш нельзя было бы ' +
          'инвалидировать заменой файла',
      ).toBe(PAGES);
    }
  });

  // 2.4 — страж вакуума, отдельно от запрета удвоения (tasks.md 2.13): без него весь тест
  // краснел от одной причины, и происхождение цвета было не видно.
  it('2.4 [RED] Cache-Control объявлен хотя бы в одном блоке', () => {
    const parsed = cfg();
    const blocks: Block[] = [parsed.server, ...parsed.server.children];
    const declaring = blocks.filter((b) => cacheControls(b).length > 0);
    expect(
      declaring.length,
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: Cache-Control не объявлен ни в одном блоке, поэтому ' +
        'утверждение «ни один блок не объявляет его дважды» вакуумно — оно зелено ровно ' +
        'там, где политики нет вовсе',
    ).toBeGreaterThan(0);
  });

  // 2.4 — удвоение, без стража: до реализации блоков с заголовком нет, поэтому этот тест
  // зелёный вакуумно, и это его законное состояние. Красное даёт только мутация 4.5.
  it('2.4 [GREEN-BY-DESIGN] ни один блок не объявляет Cache-Control дважды', () => {
    const parsed = cfg();
    const blocks: Block[] = [parsed.server, ...parsed.server.children];
    const doubled = blocks
      .map((b) => ({ where: b === parsed.server ? 'server' : b.header, n: cacheControls(b).length }))
      .filter((x) => x.n > 1);
    expect(
      doubled,
      `Cache-Control объявлен в блоке дважды — заголовок придёт в ответе два раза, и какой ` +
        `из них применит клиент, не определено:\n${doubled.map((d) => `${d.where}: ${d.n}`).join('\n')}`,
    ).toEqual([]);
  });

  it('2.4 блок server объявляет политику страниц ровно один раз', () => {
    const parsed = cfg();
    const decls = cacheControls(parsed.server).map((d) => readCacheDecl(d, 'server'));
    expect(
      decls.length,
      'серверное умолчание политики страниц отсутствует или объявлено не один раз — ' +
        'без него 264 правила перенаправления отвечают без Cache-Control',
    ).toBe(1);
    expect(decls[0].value, 'серверное умолчание отдаёт не политику страниц').toBe(PAGES);
  });

  // Характеризационная: `location /` не объявляет заголовков и сейчас, требование лишь
  // запрещает это изменить. Закрывается мутацией 4.16 (добавить в `location /` свой
  // `add_header Cache-Control`). Правила перенаправления от этой мутации не страдают —
  // они отдельные блоки `location = <адрес>` и наследуют прямо от `server`, а не через
  // `location /`, который им не родитель. Ломается другое: страницы отвечают политикой
  // этого блока вместо серверного умолчания, а сам блок теряет весь серверный набор
  // заголовков целиком (design.md, Решение 3).
  it('2.4 [GREEN-BY-DESIGN] блок location / своего Cache-Control не объявляет — он наследует серверный', () => {
    const parsed = cfg();
    const root = parsed.locs.find((l) => l.kind === 'prefix' && l.pattern === '/');
    expect(
      root,
      'в конфигурации нет блока location / — предмет проверки изменился, а вместе с ним ' +
        'и обработчик, который держит try_files',
    ).toBeDefined();
    expect(
      cacheControls(root!.block).length,
      'location / объявил свой Cache-Control. Он обязан наследовать серверный: тем же ' +
        'наследованием живут правила перенаправления, подключаемые include',
    ).toBe(0);
  });

  // 2.5 — always. Мутация 4.11 (снять always с политики страниц).
  it('2.5 always стоит у политики страниц: страница ошибки тоже получает политику', () => {
    const parsed = cfg();
    const decls = cacheControls(parsed.server).map((d) => readCacheDecl(d, 'server'));
    expect(decls.length, 'серверного Cache-Control нет — проверять always не на чем').toBe(1);
    expect(
      decls[0].always,
      'у серверного Cache-Control нет always. Без него 404 не получает политику страниц, ' +
        'и клиент кеширует «страницы нет» эвристически по Last-Modified',
    ).toBe(true);
  });

  // 2.5, обратная сторона. Мутация 4.6 (добавить always в правило /_astro/).
  it.each(OWN_TTL_CLASSES.filter((k) => k.immutable))(
    '2.5 у неизменяемого класса $name always отсутствует',
    (klass) => {
      for (const uri of klass.uris) {
        const r = resolveCacheControl(cfg(), uri);
        expect(r.source, `по адресу ${uri} значение приходит из «${r.where}», а не из своего правила`).toBe(
          'location',
        );
        expect(
          r.decls[0].always,
          `правило «${r.where}» помечено always. Годовой immutable попал бы на ответ ` +
            '«файла нет»: выкладка переключает symlink, запрос в окне переключения получает ' +
            '404 на существующий файл, и клиент закрепил бы это на год',
        ).toBe(false);
      }
    },
  );

  // 2.6 — сжатие. Мутация 4.4 (удалить gzip_types, оставив gzip on).
  it('2.6 gzip включён нашей конфигурацией, а не умолчанием образа хоста', () => {
    const parsed = cfg();
    const on = parsed.server.directives.filter((d) => d.name === 'gzip' && d.args[0] === 'on');
    expect(
      on.length,
      'в блоке server нет gzip on. Сжатие HTML на стенде сегодня работает умолчанием ' +
        'дистрибутива — оно не наше, в нашем тексте его нет, и другой образ хоста меняет ' +
        'его молча',
    ).toBeGreaterThan(0);
  });

  it('2.6 gzip_types задан и покрывает CSS, JavaScript, SVG, XML, JSON, обычный текст', () => {
    const types = gzipTypes(cfg());
    // Каждая строка из accept обязательна (tasks.md 2.13) — не «любая из», а «все»:
    // для XML и JavaScript их по две, и перечень с одной удовлетворял бы старому,
    // более слабому зачёту. Сообщение называет каждую отсутствующую строку по имени,
    // как того требует сценарий спеки «Перечень называет только одно из двух написаний
    // типа».
    const missing = REQUIRED_GZIP_GROUPS.flatMap((g) =>
      g.accept.filter((t) => !types.includes(t)).map((t) => `${g.what}: ${t}`),
    );
    expect(
      missing,
      `в gzip_types нет обязательных написаний:\n${missing.join('\n')}\nЗадано: ${types.join(' ')}`,
    ).toEqual([]);
  });

  // Мутация 4.12.
  it('2.6 gzip_types не содержит text/html', () => {
    const types = gzipTypes(cfg());
    expect(
      types.includes('text/html'),
      'text/html в gzip_types. nginx сжимает его всегда, а повторное упоминание даёт ' +
        'предупреждение duplicate MIME type, которое nginx -t ошибкой не считает — ' +
        'и поэтому его легко не заметить',
    ).toBe(false);
  });

  // Мутация 4.13.
  it('2.6 gzip_types не содержит уже сжатых типов (woff2, png, jpeg, webp, архивы)', () => {
    const types = gzipTypes(cfg());
    const bad = types.filter((t) => FORBIDDEN_COMPRESSED_TYPES.includes(t));
    expect(
      bad,
      `в gzip_types уже сжатое содержимое: ${bad.join(', ')}. Повторное сжатие расходует ` +
        'процессор хоста и ответ не уменьшает',
    ).toEqual([]);
  });

  // Мутация 4.14 — самая незаметная из запретительных ветвей.
  it('2.6 gzip_types не содержит application/octet-stream', () => {
    const types = gzipTypes(cfg());
    expect(
      types.includes('application/octet-stream'),
      'application/octet-stream в gzip_types. Под этот тип попадают файлы данных поиска ' +
        '(расширения .pf_* nginx не знает), а они УЖЕ являются gzip-потоками: сжатие их ' +
        'не уменьшает, а увеличивает (1696 → 1742 байта, измерено). Клиент поиска ' +
        'распаковывает их сам',
    ).toBe(false);
  });

  // 2.7 — ветка вакуума формы правил. Без правил кеша сравнивать формы не с чем, и
  // «пересечений нет» здесь означало бы «проверить не удалось».
  it('2.7 в конфигурации есть правила кеша — иначе форму сравнивать не с чем', () => {
    const parsed = cfg();
    const cacheRules = parsed.locs.filter((l) => cacheControls(l.block).length > 0);
    expect(
      cacheRules.length,
      'ни один location не объявляет своего Cache-Control: правил кеша в конфигурации нет, ' +
        'и утверждение «форма правил не отбирает адреса у перенаправлений» вакуумно',
    ).toBeGreaterThan(0);
  });

  // Мутация 4.15 (переписать правило карт сайта на location = /sitemap.xml).
  it('2.7 ни одно правило кеша не задано точным совпадением адреса, у которого есть перенаправление', () => {
    const parsed = cfg();
    const redirects = redirectAddresses();
    expect(
      redirects.length,
      `в ${REDIRECTS_REL} не найдено ни одного location = <адрес> — сверять множества не с чем ` +
        '(запустите npm run redirects:gen)',
    ).toBeGreaterThan(0);
    // Частный случай, ради которого проверка заведена: файла sitemap.xml в сборке нет,
    // адрес существует только как 301 и зарегистрирован во внешних сервисах, но под класс
    // «имя начинается с sitemap, оканчивается на .xml» он попадает буквально.
    expect(
      redirects,
      `в ${REDIRECTS_REL} нет правила для /sitemap.xml — опорный случай проверки исчез`,
    ).toContain('/sitemap.xml');

    const stolen = parsed.locs
      .filter((l) => l.kind === 'exact' && redirects.includes(l.pattern))
      .map((l) => l.pattern);
    expect(
      stolen,
      `правила кеша заданы точным совпадением адресов, у которых есть перенаправление: ` +
        `${stolen.join(', ')}. Точное совпадение в nginx выигрывает у любой другой формы, ` +
        'поэтому перенаправление было бы отобрано молча, и снаружи это видно только ' +
        'запросом того самого адреса',
    ).toEqual([]);
  });

  // Требование «Заголовок кеширования не теряется и не удваивается», оговорка AND сценария
  // «Перенаправление со старого адреса тоже несёт политику»: правило перенаправления
  // своего значения не объявляет, и наследование серверного — единственное, что удерживает
  // 264 таких правила от ответа без политики. Файл генерируемый, add_header в нём нет
  // сейчас — проверка характеризационная. Закрывается мутацией 4.17 (посторонний
  // add_header в шаблоне генератора `web/scripts/gen-redirects.ts`, без своего
  // Cache-Control) — её следствие: 263 из 264 правил отвечают без Cache-Control, а
  // /sitemap.xml, напечатанный отдельным литералом, продолжает его наследовать.
  it('[GREEN-BY-DESIGN] правила перенаправления не объявляют своих add_header', () => {
    const rules = redirectRules();
    expect(
      rules.length,
      `в ${REDIRECTS_REL} нет ни одного location — проверять наследование не на чем ` +
        '(запустите npm run redirects:gen)',
    ).toBeGreaterThan(0);
    const declaring = rules.filter((b) => addHeaders(b).length > 0).map((b) => b.header);
    expect(
      declaring,
      `правила перенаправления объявили свои add_header: ${declaring.join(', ')}. ` +
        'В nginx набор add_header не складывается по уровням: объявив свой, правило теряет ' +
        'серверный целиком — и ответ 301 приходит без Cache-Control',
    ).toEqual([]);
  });

  // 2.8 [GREEN-BY-DESIGN]: адресный контракт существует до этого change; проверка
  // характеризационная. За неё отвечают мутации 4.8 и 4.9, а не красный прогон.
  it('2.8 [GREEN-BY-DESIGN] порядок try_files сохранён: $uri/index.html раньше $uri/', () => {
    const parsed = cfg();
    const root = parsed.locs.find((l) => l.kind === 'prefix' && l.pattern === '/');
    expect(root, 'нет блока location / — предмет проверки исчез').toBeDefined();
    const tryFiles = root!.block.directives.filter((d) => d.name === 'try_files');
    expect(tryFiles.length, 'в location / нет try_files — адреса страниц перестанут работать').toBe(
      1,
    );
    expect(
      tryFiles[0].args,
      'порядок try_files изменён. Если $uri/ окажется раньше $uri/index.html, nginx ответит ' +
        '301 на вариант со завершающим слэшем, и адрес разойдётся с каноническим',
    ).toEqual(['$uri', '$uri/index.html', '$uri/', '=404']);
  });

  it('2.8 [GREEN-BY-DESIGN] include файла правил перенаправления стоит внутри vhost', () => {
    // Строже, чем repo-hygiene.test.ts: там include ищется по всему тексту скрипта, здесь —
    // в теле heredoc'а. Ответы обеих обязаны совпадать (tasks.md 2.9).
    const parsed = cfg();
    const includes = parsed.server.directives.filter(
      (d) => d.name === 'include' && /nginx-redirects\.conf$/.test(d.args[0] ?? ''),
    );
    expect(
      includes.length,
      'в блоке server нет include файла правил перенаправления — 264 правила существовали бы ' +
        'только в репозитории, а на сервере старые адреса отдавали бы 404',
    ).toBe(1);
  });

  it('2.8 [GREEN-BY-DESIGN] error_page 404 отдаёт страницу ошибки сайта', () => {
    const parsed = cfg();
    const errorPages = parsed.server.directives.filter((d) => d.name === 'error_page');
    const has404 = errorPages.some((d) => d.args[0] === '404' && d.args[1] === '/404.html');
    expect(
      has404,
      'нет error_page 404 /404.html. Помимо страницы ошибки это второй, независимый механизм, ' +
        'которым 404 под /_astro/ получает политику страниц: внутреннее перенаправление ' +
        'формирует ответ правилом страниц при сохранённом коде 404',
    ).toBe(true);
  });

  // Сценарий «Правил перенаправления пока нет» (tasks.md 2.12): механизм — файл создаётся
  // ДО nginx -t, потому что include одного отсутствующего файла есть ошибка конфигурации,
  // а пустой include законен. Закрывается мутацией 4.18 (перенести touch после nginx -t).
  //
  // ПРАВЛЕНО (найдено сессией реализации serving-cache-headers, tasks.md 4.18): предмет
  // сценария — порядок ВНУТРИ пути записи свежего vhost (после того, как heredoc NGINX
  // записан). В скрипте есть ВТОРОЙ, не связанный с этим путём touch того же файла — в
  // ветке раннего выхода «vhost уже существует» (`exit 3`, до открытия heredoc'а NGINX
  // вообще). Прежняя версия искала обе позиции по ВСЕМУ файлу: `.search()` находил
  // ПЕРВОЕ совпадение touch, а это неизменно был touch раннего выхода — он текстово
  // всегда стоит раньше nginx -t независимо от положения настоящего touch, поэтому
  // мутация 4.18 (переставить настоящий touch после nginx -t) эту проверку не красила —
  // проверка существовала, но гейтом не была. Обе позиции теперь ищутся только в тексте
  // ПОСЛЕ закрывающего разделителя heredoc'а — единственном месте, где сценарий применим.
  it('[GREEN-BY-DESIGN] файл правил перенаправления создаётся до nginx -t', () => {
    const lines = readFileSync(join(ROOT, BOOTSTRAP_REL), 'utf-8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'));
    const heredocClose = lines.findIndex((l) => l.trim() === HEREDOC);
    expect(
      heredocClose,
      `не найден закрывающий разделитель heredoc'а ${HEREDOC} — предмет сценария (порядок ` +
        'внутри пути записи свежего vhost) искать не в чём',
    ).toBeGreaterThan(-1);
    const afterHeredoc = lines.slice(heredocClose + 1).join('\n');
    const touch = afterHeredoc.search(/touch\s+"?\$\{?WEB_ROOT\}?[^"\n]*nginx-redirects\.conf/);
    const test = afterHeredoc.search(/^\s*nginx -t\s*$/m);
    expect(
      touch,
      'после heredoc\'а скрипт не создаёт файл правил перенаправления',
    ).toBeGreaterThan(-1);
    expect(
      test,
      'после heredoc\'а скрипт не проверяет конфигурацию через nginx -t',
    ).toBeGreaterThan(-1);
    expect(
      touch < test,
      'файл правил создаётся ПОСЛЕ nginx -t: include одного отсутствующего файла — ошибка ' +
        'конфигурации, и первичная настройка упала бы на пустом наборе правил',
    ).toBe(true);
  });

  // 2.13.3 — страж вакуумности. Стоит ПЕРВЫМ из трёх проверок класса намеренно: его
  // предмет — существование правила, а не его содержимое, и он отличает «правила нет»
  // (правило удалено целиком, мутация 4.23) от «правило есть, но пустое» (удалён один
  // add_header внутри блока — другой дефект, его ловит 2.13.1). Без этого различения
  // «несоответствий не найдено» и «проверять было нечего» слились бы в один зелёный цвет.
  it('2.13.3 [RED] страж: правило класса корневых .svg найдено в разобранном heredoc', () => {
    const parsed = cfg();
    // Пустой перечень представителей — тоже «проверить не удалось»: утверждения ниже
    // стали бы истинными на пустом множестве адресов.
    expect(
      ROOT_SVG_URIS.length,
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: перечень представителей класса корневых .svg пуст — ' +
        'утверждения о классе были бы истинны вакуумно',
    ).toBeGreaterThan(0);
    const uncovered = ROOT_SVG_URIS.filter((uri) => regexLocsMatching(parsed, uri).length === 0);
    expect(
      uncovered,
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в теле heredoc'а ${HEREDOC} нет правила класса корневых .svg — ` +
        `под адреса ${uncovered.join(', ')} не подходит ни одно регулярное выражение ` +
        'location. Отсутствие правила успехом не считается: ни его значение, ни порядок ' +
        'объявления утверждать не на чем.',
    ).toEqual([]);
    // Правило класса не совпадает с правилом favicon: иначе классов один, а спека
    // требует двух с заданным между ними порядком.
    const svg = soleRegexLocFor(parsed, ROOT_SVG_URIS[0], 'класса корневых .svg');
    const favicon = soleRegexLocFor(parsed, FAVICON_ONLY_URI, 'класса favicon.');
    expect(
      svg.block === favicon.block,
      `ПРОВЕРИТЬ НЕ УДАЛОСЬ: корневые .svg и favicon. обслуживает одно и то же правило ` +
        `«${svg.block.header}» — классов в конфигурации один, а спека задаёт два, и ` +
        'утверждение об их порядке применять не к чему',
    ).toBe(false);
  });

  // 2.13.1 — значение класса, утверждаемое В ЕГО ПРАВИЛЕ. Проверка «в конфиге есть
  // max-age=86400» здесь непригодна по построению: то же значение несёт класс `favicon.`,
  // который в конфигурации уже есть, поэтому такая проверка зелёная и на конфигурации без
  // нового правила вовсе. Мутация 4.23 (снять блок целиком) обязана ронять именно эту
  // проверку и 2.13.3, а не проверки других классов.
  it('2.13.1 [RED] класс корневых .svg объявляет своё значение в СВОЁМ правиле', () => {
    const parsed = cfg();
    for (const uri of ROOT_SVG_URIS) {
      const r = resolveCacheControl(parsed, uri);
      expect(r.source, r.source === 'absent' ? absentWhy(r, uri) : '').not.toBe('absent');
      expect(
        r.source,
        `по адресу ${uri} значение приходит из «${r.where}». Класс корневых .svg обязан ` +
          'объявлять свой срок в собственном правиле: значение совпадает со значением ' +
          'класса favicon., поэтому наследование серверной политики или совпадение ' +
          'значения в чужом правиле требование не удовлетворяют',
      ).toBe('location');
      expect(
        r.decls.length,
        `по адресу ${uri} в «${r.where}» объявлений Cache-Control ${r.decls.length}, а не одно`,
      ).toBe(1);
      expect(
        r.decls[0].value,
        `класс корневых .svg: по адресу ${uri} действует значение из «${r.where}»`,
      ).toBe(ROOT_SVG_VALUE);
      // Отдельные утверждения, а не следствия равенства выше: спека запрещает этому классу
      // годовой срок и `immutable` самостоятельным SHALL NOT — имена корневых .svg не несут
      // хеша содержимого, и годовое обещание закрепило бы у посетителя старую графику без
      // возможности починить это выкладкой.
      expect(
        r.decls[0].value.includes('immutable'),
        `в значении класса корневых .svg есть immutable («${r.decls[0].value}»). Имена этих ` +
          'файлов не несут хеша содержимого: графика заменяется правкой файла под тем же ' +
          'адресом, и immutable запретил бы браузеру условный запрос до истечения срока',
      ).toBe(false);
      expect(
        r.decls[0].value.includes('31536000'),
        `класс корневых .svg получил годовой срок («${r.decls[0].value}»)`,
      ).toBe(false);
      // `always` у класса нет по той же причине, что у неизменяемых классов: политика
      // класса не должна попадать на ответ «файла нет» — там действует политика страниц
      // через error_page.
      expect(
        r.decls[0].always,
        `правило «${r.where}» помечено always: суточный срок попал бы и на ответ об ` +
          'отсутствии файла, тогда как страница ошибки обязана приходить с политикой страниц',
      ).toBe(false);
    }
  });

  // 2.13.2 — ПОРЯДОК, и предмет здесь именно он. Снаружи он сегодня не наблюдаем вовсе:
  // сроки классов `favicon.` и корневых `.svg` совпадают (86400), поэтому неверный порядок
  // не меняет ни одного ответа и ни одна проверка значения не покраснела бы — до дня, когда
  // один из сроков изменят. Правила опознаются адресами, подходящими под одно из них
  // (`/favicon.ico` — только под favicon., `/hero-main.svg` — только под корневые .svg),
  // а не порядком объявления: иначе проверка утверждала бы порядок, найдя правила по нему же.
  // Мутация 4.24 (переставить блоки) обязана ронять ТОЛЬКО эту проверку.
  it('2.13.2 [RED] правило класса favicon. объявлено раньше правила корневых .svg', () => {
    const parsed = cfg();
    const favicon = soleRegexLocFor(parsed, FAVICON_ONLY_URI, 'класса favicon.');
    const svg = soleRegexLocFor(parsed, ROOT_SVG_URIS[0], 'класса корневых .svg');
    expect(
      favicon.order < svg.order,
      `правило класса favicon. («${favicon.block.header}») объявлено ПОСЛЕ правила класса ` +
        `корневых .svg («${svg.block.header}»). nginx берёт первое совпавшее регулярное ` +
        'выражение, а /favicon.svg подходит под оба — значит иконку обслуживал бы класс ' +
        'корневых .svg. Сроки классов сегодня совпадают, поэтому снаружи это не наблюдаемо ' +
        'ни одним запросом: ошибка проявится молча в день, когда один из сроков изменят',
    ).toBe(true);
    // Наблюдаемое следствие того же порядка, и оно же — оговорка AND сценария спеки
    // «Иконка сайта в обоих форматах»: /favicon.svg обслуживается классом favicon.
    const serving = matchLocation(parsed.locs, '/favicon.svg');
    expect(
      serving?.block.header,
      'адрес /favicon.svg обслуживается не правилом класса favicon., а другим правилом. ' +
        'То, какой класс его получает, задано конфигурацией, а не совпадением сроков',
    ).toBe(favicon.block.header);
  });

  // Форма правила: класс задан КОРНЕМ сайта, а не любым `.svg`. Метка
  // [GREEN-BY-DESIGN] — утверждение верно и до реализации (правила класса ещё нет, адрес
  // получает серверное умолчание), и после верной реализации; красное ему даёт правило,
  // записанное как `~ \.svg$` вместо одного сегмента пути. Проверка сторожит ровно эту
  // форму со стороны текста; со стороны живой раздачи тот же предмет — шаг 5.11.
  // Мутации для неё в разделе 4 `tasks.md` нет (4.23 снимает блок целиком, 4.24 меняет
  // порядок) — это пробел плана, а не свойство проверки.
  it('2.13.1 [GREEN-BY-DESIGN] класс задан корнем сайта: .svg вне корня получает политику страниц', () => {
    const parsed = cfg();
    const r = resolveCacheControl(parsed, NON_ROOT_SVG_URI);
    expect(r.source, r.source === 'absent' ? absentWhy(r, NON_ROOT_SVG_URI) : '').not.toBe(
      'absent',
    );
    expect(
      r.decls.length,
      `по адресу ${NON_ROOT_SVG_URI} в «${r.where}» объявлений Cache-Control ` +
        `${r.decls.length}, а не одно`,
    ).toBe(1);
    expect(
      r.decls[0].value,
      `по адресу ${NON_ROOT_SVG_URI} действует значение из «${r.where}». Класс задан корнем ` +
        'сайта намеренно: под /media/ замена файла — обычная правка содержимого редактором, ' +
        'и суточный срок там не согласован. Правило, записанное как \\.svg$ вместо одного ' +
        'сегмента пути, забрало бы и этот адрес, а проверка наличия правила и его значения ' +
        'этого не различает',
    ).toBe(PAGES);
  });

  // Самопроверка разборщика. Нужна, чтобы отличать «конфигурация неверна» от «разборщик
  // неверен»: молча сломанный разборщик — это ровно то «я не смогла проверить», которое
  // выдают за «нарушений нет».
  it('[самопроверка] разбор и выбор location воспроизводят правила nginx', () => {
    const fixture = `
      server {
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
        # add_header Cache-Control "zakommentirovano";
        location = /tochno { add_header X-Kind "exact"; }
        location ^~ /pref/ { add_header X-Kind "prefix-priority"; }
        location ~ \\.(pf_fragment)$ { add_header X-Kind "regex"; }
        location /pref/dlinnee/ { add_header X-Kind "longer-prefix"; }
        location / { try_files $uri $uri/index.html $uri/ =404; }
      }
    `;
    const root = parseConfig(stripComments(fixture));
    const server = root.children.find((b) => b.name === 'server')!;
    const locs = server.children
      .filter((b) => b.name === 'location')
      .map((b, i) => classifyLocation(b, i));
    const kind = (uri: string): string | null => {
      const l = matchLocation(locs, uri);
      if (!l) return null;
      const h = l.block.directives.find((d) => d.name === 'add_header' && d.args[0] === 'X-Kind');
      return h ? h.args[1] : l.block.args.join(' ');
    };

    // Комментарии сброшены до разбора: закомментированное значение в директивы не попало.
    expect(cacheControls(server).length).toBe(1);
    expect(readCacheDecl(cacheControls(server)[0], 'server').value).toBe(PAGES);
    expect(readCacheDecl(cacheControls(server)[0], 'server').always).toBe(true);

    // Точное совпадение выигрывает у префикса `/`.
    expect(kind('/tochno')).toBe('exact');
    // `^~` прекращает поиск, но только если он и есть САМЫЙ ДЛИННЫЙ совпавший префикс:
    // тогда регулярные выражения не рассматриваются вовсе.
    expect(kind('/pref/nekiy.pf_fragment')).toBe('prefix-priority');
    // Обратная сторона того же правила: более длинный обычный префикс отбирает адрес у
    // `^~`, и фаза регулярных выражений снова выполняется. Свойство несущее — правило
    // кеша с `^~` не защищено от location, объявленного позже с более длинным префиксом.
    expect(kind('/pref/dlinnee/nechto')).toBe('longer-prefix');
    // Регулярное выражение выигрывает у обычного префикса.
    expect(kind('/inoe/nekiy.pf_fragment')).toBe('regex');
    // Иначе — самый длинный обычный префикс.
    expect(kind('/kontakty')).toBe('/');
  });
});

/*
 * СЦЕНАРИИ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ (tasks.md 2.10)
 *
 * Причина у всех одна: предмет — ответ работающего сервера, а не текст. nginx не
 * является зависимостью проекта и в тестах не поднимается; `gzip` и `add_header` —
 * поведение сервера. Способ проверки — раздел 5 `tasks.md`, ручная приёмка со
 * свидетельством (`curl -sS -D- -o /dev/null -H 'Accept-Encoding: gzip' http://<host><path>`,
 * без `-L`, иначе предмет проверки подменяется следованием по редиректу).
 *
 * Требование «Кеш-политика задана классами адресов»
 *   Файл с хешем в имени; данные поиска; загрузчик и манифест поиска; шрифт; страница без
 *   расширения; иконка сайта; карта сайта и её части — фактический `Cache-Control` на
 *   проводе. Текстом проверено, ЧТО задано (2.2/2.3); что именно доехало до ответа — 5.3
 *   (загрузчик поиска — 5.4).
 *   ПРАВЛЕНО при пересчёте 7.1: «главная» (`/`) и «адрес вне классов» (`/og-image.png`,
 *   `/robots.txt`, файл из `/media/`) стояли в этом же перечне за шагом 5.3, но перечень
 *   адресов 5.3 их не содержит, и на стенде они не запрашивались — то есть числились за
 *   ручной приёмкой без шага. Их закрывает автоматическая проверка (`2.2 класс 'главная /'`
 *   и `2.2 класс 'вне перечисленных классов'`), живого шага у них НЕТ, и дописывать его под
 *   удобство здесь нечем: класс обслуживает `location /` тем же наследованием, что и
 *   измеренный `/kontakty`.
 *   Адрес карты сайта с правилом перенаправления (`/sitemap.xml` → 301) — 5.5. Текстом
 *   проверено лишь то, что правило кеша этот адрес не отбирает (2.7).
 *   Страница карты сайта для человека (`/sitemap` → 200 с политикой страниц) — 5.6.
 *   Векторная графика в корне сайта (`/hero-main.svg` → 200 с `max-age=86400`) — 5.12;
 *   текстом проверено, что задано (2.13.1) и каким классом обслуживается `/favicon.svg`
 *   (2.13.2). Векторная графика ВНЕ корня (`.svg` под `/media/` → политика страниц) —
 *   5.11; текстом проверена форма правила (2.13.1 [GREEN-BY-DESIGN]). Порядок правил
 *   `favicon.` и корневых `.svg` на живой раздаче не наблюдаем вовсе — сроки классов
 *   совпадают, поэтому 5.3 записывает оба ответа целиком, а утверждение о порядке
 *   остаётся текстовым (2.13.2).
 *
 * Требование «Заголовок кеширования не теряется и не удваивается»
 *   Один заголовок в ответе 200/404/301 — 5.3, 5.5. Текстом проверено число объявлений в
 *   блоке (2.4) и то, что заголовок не потерян наследованием (2.2 через `absent`).
 *
 * Требование «Неизменяемость не распространяется на ответы об отсутствии»
 *   404 под `/_astro/` без годового `immutable` — 5.7. Страница ошибки с политикой
 *   страниц и прямой запрос `/404.html` — 5.6. Текстом проверены оба механизма, которые
 *   это дают: отсутствие `always` у неизменяемых правил (2.5) и `error_page` (2.8).
 *
 * Требование «Сжатие задано конфигурацией сайта и покрывает текстовые типы»
 *   `Content-Encoding: gzip` для CSS, поискового скрипта, SVG, карты сайта и страницы —
 *   5.4; отсутствие сжатия для woff2 и данных поиска — 5.4. Ответ клиенту БЕЗ
 *   `Accept-Encoding` (сценарий «Клиент без поддержки сжатия») — 5.9: команды 5.1–5.7
 *   идут с `-H 'Accept-Encoding: gzip'`, у 5.9 заголовок другой (`identity`), поэтому это
 *   отдельный шаг, а не частный случай общей команды.
 *
 * Требование «Введение политики не ухудшает уже достигнутое кеширование»
 *   «Шрифт берётся из кеша без обращения к сети» — 5.10 (снимок панели «Сеть» браузера,
 *   вторая страница после прогрева кеша); текстовая причина — `max-age=2592000` у класса
 *   `/fonts/` (проверено 2.2) и наблюдаемый заголовок (5.3). Сценарий «Принятая плата
 *   названа» документарный: он удовлетворён `design.md` (Решение 7) и проверяется
 *   чтением, а не прогоном.
 *
 * Требование «Введение правил раздачи сохраняет адресный контракт»
 *   `/kontakty` → 200 без 301 на слэш; `/contacts` → 301 — 5.5. Текстом проверены
 *   механизмы: порядок `try_files` и `include` (2.8), запрет точного совпадения (2.7).
 *   «Правил перенаправления пока нет» проверяется характеризационно — файл создаётся до
 *   `nginx -t`.
 *
 * Требование «Действие политики на живой раздаче подтверждается свидетельством»
 *   Целиком ручное по построению (раздел 5). Сценарий «Расхождение текста и живой
 *   раздачи» утверждает, что состояние НЕ обнаруживается автоматическими проверками, —
 *   автоматизировать его нельзя по смыслу; он зафиксирован как известное ограничение и
 *   долг в `docs/tech-debt.md` (задача 3.11).
 */
