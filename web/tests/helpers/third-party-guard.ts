import type { Page, Route, Request } from '@playwright/test';

/**
 * Перехват сторонних запросов в браузерном прогоне.
 *
 * ── ЗАЧЕМ ОН ЕСТЬ ───────────────────────────────────────────────────────────
 * Спека change `external-widgets` требует: «браузерный прогон, чей предмет НЕ является
 * сторонним сервисом, SHALL NOT зависеть от его доступности». Обеспечивается это
 * по-разному в разных прогонах, и разница не деталь:
 *
 *  - в конфигурациях `playwright.preview.config.ts` и `playwright.stand.config.ts` любое
 *    внешнее имя уже неразрешимо на уровне браузера (`--host-resolver-rules=MAP *
 *    ~NOTFOUND`) — там перехват ДОБАВЛЯЕТСЯ к запрету, а не заменяет его;
 *  - в конфигурациях без этих правил перехват — единственный слой.
 *
 * ── ПОЧЕМУ НИ ОДНОГО ОБРАЩЕНИЯ НАРУЖУ ───────────────────────────────────────
 * Запрет разрешения имён НЕ является fail-closed для обработчика: обработчик, который
 * вместо подмены делает запрос своими средствами, разрешает имя ВНЕ браузера и флага не
 * видит — измерено, такой запрос проходит. Поэтому здесь нет ни `route.continue()`, ни
 * `route.fetch()`, ни `fetch`, ни `node:http`. Ответ всегда собирается из заданного
 * содержимого.
 *
 * ── ГРАНУЛЯРНОСТЬ ───────────────────────────────────────────────────────────
 * Перехват ставится ПО ПРОГОНУ, а не по конфигурации: конфигурация, в которую его надо
 * вводить, собирает и прогон сравнения с живым старым сайтом, предмет которого и есть
 * внешний ответ. Перехват на уровне конфигурации сломал бы ровно то, что исключение
 * защищает.
 *
 * Известная граница, названная вслух: перехвата НЕТ у измерения бюджетов
 * производительности — оно запускает настоящий браузер по боевому выводу
 * (`web/lighthouserc.cjs:16`, `staticDistDir: './dist',`) и хука для подмены не имеет
 * вовсе. Для него требование неприменимо, и это записано известным отклонением.
 */

/** Хосты, обращения к которым считаются «своими» и не перехватываются. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface GuardOptions {
  /**
   * Тело подставного документа виджета отзывов. По умолчанию — документ ФИКСИРОВАННОГО
   * размера: проверка сдвига раскладки не имеет права зависеть от того, сколько отзывов
   * у организации сегодня.
   */
  reviewsWidgetBody?: string;
  /**
   * Тело подставного загрузчика чата. По умолчанию — скрипт, вставляющий фокусируемый
   * интерфейс в объявленную нами точку монтирования: сценарий про фокус опирается на
   * ПОДСТАВНОЙ интерфейс, живого в браузерных прогонах нет по требованию о перехвате.
   */
  chatLoaderBody?: string;
  /** Адрес загрузчика чата: перехватывается по хосту и пути, а не угадывается. */
  chatLoaderSrc?: string | null;
  /**
   * Идентификатор чужого счётчика, который несёт подставной документ виджета. Ноль
   * значит «виджет без своей аналитики» — так проверяется, что признак гашения опирается
   * на встраивание, а не на аналитику внутри него.
   */
  foreignMetrikaId?: string | null;
}

export interface ThirdPartyGuard {
  /** Все перехваченные адреса в порядке появления. */
  readonly urls: string[];
  /** Хосты, к которым страница обращалась. */
  hosts(): string[];
  /** Обращения к хосту (сравнение по суффиксу домена). */
  toHost(host: string): string[];
  /**
   * Идентификаторы счётчиков, снятые из адреса трекинг-ПИКСЕЛЯ.
   *
   * Различать наш и чужой счётчик по адресу нельзя в принципе: тег Метрики у нас и у
   * виджета — буквально один URL, различие несёт только идентификатор, и несёт его путь
   * пикселя (`/watch/<id>`), а не адрес тега.
   */
  counterIds(): string[];
}

const FIXED_WIDGET_BODY = (foreignMetrikaId: string | null): string => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Отзывы организации</title>
<style>html,body{margin:0}#stub{height:400px;background:#f2f2f2;font:14px sans-serif}</style>
</head><body><div id="stub">подставной документ виджета отзывов</div>${
  foreignMetrikaId === null
    ? ''
    : `<img src="https://mc.yandex.ru/watch/${foreignMetrikaId}" style="position:absolute;left:-9999px" alt="">`
}</body></html>`;

/**
 * Подставной тег Метрики.
 *
 * Он ЭМУЛИРУЕТ ИЗМЕРЕННЫЙ контракт, а не изображает работу счётчика: настоящий тег
 * забирает очередь `window.ym.a`, которую синхронно наполняет сниппет
 * (`web/src/components/Analytics.astro:24`, `window.ym = window.ym || function (...args) {`),
 * и обращается к `mc.yandex.ru/watch/<id>`. Без этой эмуляции идентификатор НАШЕГО
 * счётчика в перехвате не появился бы вовсе, и «различены по идентификатору» проверять
 * было бы нечем.
 */
const METRIKA_TAG_STUB = `(function () {
  var fire = function (id) { var i = new Image(); i.src = 'https://mc.yandex.ru/watch/' + id; };
  var queued = (window.ym && window.ym.a) || [];
  window.ym = function () { if (arguments[1] === 'init') fire(arguments[0]); };
  for (var i = 0; i < queued.length; i += 1) if (queued[i][1] === 'init') fire(queued[i][0]);
})();`;

const CHAT_LOADER_STUB = `(function () {
  var mount = document.querySelector('[data-chat-mount]');
  if (!mount) return;
  var panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Подставной интерфейс чата');
  panel.setAttribute('data-chat-stub-panel', '');
  panel.tabIndex = -1;
  var close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Закрыть';
  panel.appendChild(close);
  mount.appendChild(panel);
})();`;

export async function installThirdPartyGuard(
  page: Page,
  options: GuardOptions = {},
): Promise<ThirdPartyGuard> {
  const urls: string[] = [];
  const foreignId = options.foreignMetrikaId === undefined ? '57020224' : options.foreignMetrikaId;
  const loader = options.chatLoaderSrc ?? null;
  const loaderParsed = loader === null ? null : safeUrl(loader);

  const external = (raw: string): boolean => {
    const url = safeUrl(raw);
    return url !== null && !LOOPBACK.has(url.hostname);
  };

  await page.route(
    (url) => external(url.toString()),
    async (route: Route, request: Request) => {
      const raw = request.url();
      urls.push(raw);
      const url = safeUrl(raw)!;
      const host = url.hostname.toLowerCase();

      if (host.endsWith('yandex.ru') && url.pathname.startsWith('/maps-reviews-widget/')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: options.reviewsWidgetBody ?? FIXED_WIDGET_BODY(foreignId),
        });
        return;
      }
      if (host === 'mc.yandex.ru' && url.pathname === '/metrika/tag.js') {
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: METRIKA_TAG_STUB });
        return;
      }
      if (
        loaderParsed !== null &&
        host === loaderParsed.hostname.toLowerCase() &&
        url.pathname === loaderParsed.pathname
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: options.chatLoaderBody ?? CHAT_LOADER_STUB,
        });
        return;
      }
      if (/\.(png|gif|jpe?g|webp|avif|svg)$/i.test(url.pathname) || url.pathname.startsWith('/watch/')) {
        // Прозрачный gif 1×1: подставляется БАЙТАМИ, к настоящему хосту обращения нет.
        await route.fulfill({
          status: 200,
          contentType: 'image/gif',
          body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
        });
        return;
      }
      if (/\.js$/i.test(url.pathname)) {
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* перехвачено */' });
        return;
      }
      if (/\.css$/i.test(url.pathname)) {
        await route.fulfill({ status: 200, contentType: 'text/css', body: '/* перехвачено */' });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
    },
  );

  return {
    urls,
    hosts: () => [...new Set(urls.map((u) => safeUrl(u)?.hostname ?? '').filter(Boolean))],
    toHost: (host: string) =>
      urls.filter((u) => {
        const parsed = safeUrl(u);
        if (parsed === null) return false;
        const h = parsed.hostname.toLowerCase();
        return h === host.toLowerCase() || h.endsWith(`.${host.toLowerCase()}`);
      }),
    counterIds: () =>
      urls
        .map((u) => safeUrl(u))
        .filter((u): u is URL => u !== null)
        .map((u) => /^\/watch\/(\d+)/.exec(u.pathname)?.[1])
        .filter((id): id is string => id !== undefined),
  };
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
