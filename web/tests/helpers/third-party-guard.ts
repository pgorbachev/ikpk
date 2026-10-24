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
 *
 * ── ПОДСТАВНЫХ ОТВЕТОВ ВИДЖЕТА ДВА, И ОБА ОБЪЯВЛЕНЫ ЗДЕСЬ ───────────────────
 * Спека требует именно этого: «используется один из двух названных подставных ответов:
 * ответ ФИКСИРОВАННОГО РАЗМЕРА — для проверки сдвига раскладки, и ответ, НЕСУЩИЙ ПИКСЕЛЬ
 * чужого счётчика — для проверки различения счётчиков; оба объявлены в одном месте вместе
 * со списком хостов». Без этого у проверки различения счётчиков нет построимого красного
 * состояния: живого ответа в прогонах нет по требованию о перехвате, значит пиксель обязан
 * прийти из подставного ответа, а какой именно — должно быть сказано, а не угадано.
 */

/** Хосты, обращения к которым считаются «своими» и не перехватываются. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Перечень сторонних хостов, которые перехват обязан накрывать.
 *
 * Список ПЛОСКИЙ и без деления на «наши» и «чужие»: у общего адреса тега Метрики такого
 * деления не существует — наша аналитика и виджет отзывов загружают буквально один URL, и
 * различие несёт только идентификатор счётчика. Перечень нужен перехвату и политике
 * содержимого, а там правильно одно вхождение на адрес.
 *
 * Сам перехват при этом устроен ШИРЕ перечня — он накрывает любой не-loopback хост.
 * Перечень существует как объявление предмета, а не как признак отбора: признак,
 * ограниченный списком, пропустил бы хост, о котором мы не знали, — а спека требует, чтобы
 * ни один сторонний сервис не попал в прогон живым.
 */
export const THIRD_PARTY_HOSTS = [
  'yandex.ru',
  'avatars.mds.yandex.net',
  'mc.yandex.ru',
  'yastatic.net',
] as const;

/** Идентификатор чужого счётчика, приходящего внутри виджета отзывов. */
const FOREIGN_METRIKA_ID = '57020224';

export interface GuardOptions {
  /**
   * Тело подставного документа виджета отзывов. По умолчанию — ответ ФИКСИРОВАННОГО
   * размера, несущий пиксель чужого счётчика.
   */
  reviewsWidgetBody?: string;
  /**
   * Тело подставного загрузчика чата. По умолчанию — изолированный stub измеренной
   * геометрии нативного launcher и provider overlay; он не доказывает live-portal acceptance.
   */
  chatLoaderBody?: string;
  /** Адрес загрузчика чата: перехватывается по хосту и пути, а не угадывается. */
  chatLoaderSrc?: string | null;
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

/**
 * ПЕРВЫЙ подставной ответ: фиксированного размера, без чужой аналитики.
 *
 * Для проверки сдвига раскладки. Размер фиксирован намеренно: на живом ответе проверка
 * зависела бы от того, сколько отзывов у организации сегодня. Пикселя чужого счётчика
 * здесь нет — этим же ответом проверяется, что признак гашения опирается на встраивание, а
 * не на аналитику внутри него.
 */
export const FIXED_SIZE_WIDGET_BODY = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Отзывы организации</title>
<style>html,body{margin:0}#stub{height:400px;background:#f2f2f2;font:14px sans-serif}</style>
</head><body><div id="stub">подставной документ виджета отзывов</div></body></html>`;

/**
 * ВТОРОЙ подставной ответ: тот же фиксированный размер плюс пиксель ЧУЖОГО счётчика.
 *
 * Для проверки различения счётчиков по идентификатору. Пиксель несёт идентификатор в самом
 * пути (`/watch/57020224`), тогда как адрес тега идентификатора не несёт вовсе — измерено,
 * и именно поэтому признаком служит пиксель, а не адрес загрузки тега.
 */
export const WIDGET_BODY_WITH_FOREIGN_PIXEL = FIXED_SIZE_WIDGET_BODY.replace(
  '</body>',
  `<img src="https://mc.yandex.ru/watch/${FOREIGN_METRIKA_ID}" style="position:absolute;left:-9999px" alt=""></body>`,
);

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

/**
 * Isolated browser stub for the measured native launcher contract. Its fixed 66×66
 * launcher at right/bottom 50px and provider overlay z-indexes represent the captured
 * Bitrix geometry used by this repository's tests. This is test scaffolding only: it
 * does not attest to a live portal greeting, chooser channels, or VK Open Line.
 */
const CHAT_LOADER_STUB = `(function () {
  var style = document.createElement('style');
  style.textContent = '[data-chat-stub-launcher]{position:fixed!important;box-sizing:border-box!important;' +
    'right:50px!important;bottom:50px!important;width:66px!important;height:66px!important;border-radius:50%;' +
    'background:#16a765;color:#fff;z-index:10150!important;cursor:pointer}' +
    '[data-chat-stub-greeting]{position:fixed!important;box-sizing:border-box!important;right:40px!important;' +
    'bottom:126px!important;z-index:10100!important;max-width:min(320px,calc(100vw - 32px));padding:16px;' +
    'background:#fff;color:#111;box-shadow:0 2px 12px #0004}' +
    '[data-chat-stub-overlay]{position:fixed!important;inset:0!important;z-index:10100!important;' +
    'background:rgba(0,0,0,.18);pointer-events:auto}' +
    '[data-chat-stub-wrapper]{position:fixed!important;inset:0!important;z-index:10150!important;pointer-events:none}' +
    '[data-chat-stub-chooser]{position:fixed!important;right:0!important;bottom:0!important;' +
    'width:min(360px,100vw);height:min(560px,100vh);box-sizing:border-box;padding:18px;' +
    'background:#fff;color:#111;box-shadow:0 2px 16px #0005;pointer-events:auto}';
  document.head.appendChild(style);
  var wrapper = document.createElement('div');
  wrapper.setAttribute('data-chat-stub-wrapper', '');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.hidden = true;
  var launcher = document.createElement('div');
  launcher.setAttribute('data-chat-stub-launcher', '');
  launcher.textContent = '';
  var greeting = document.createElement('div');
  greeting.setAttribute('data-chat-stub-greeting', '');
  greeting.textContent = 'Подставное приветствие Bitrix';
  var greetingClose = document.createElement('span');
  greetingClose.setAttribute('data-chat-stub-greeting-close', '');
  greetingClose.textContent = ' ×';
  greeting.appendChild(greetingClose);
  var chooser = document.createElement('div');
  chooser.setAttribute('data-chat-stub-chooser', '');
  chooser.setAttribute('data-chat-stub-panel', '');
  var nativePlaceholder = document.createElement('a');
  nativePlaceholder.setAttribute('data-chat-stub-native-placeholder', '');
  nativePlaceholder.setAttribute('href', '#');
  var chooserClose = document.createElement('div');
  chooserClose.setAttribute('data-chat-stub-chooser-close', '');
  chooserClose.className = 'b24-widget-button-inner-item b24-widget-button-close';
  chooserClose.textContent = '×';
  chooser.append(nativePlaceholder, chooserClose);
  var opened = false;
  var open = function () {
    if (opened) return;
    opened = true;
    wrapper.hidden = false;
    wrapper.removeAttribute('aria-hidden');
    wrapper.appendChild(chooser);
    overlay.hidden = false;
    document.body.appendChild(overlay);
  };
  var closeChooser = function () {
    overlay.remove();
    wrapper.hidden = true;
    wrapper.setAttribute('aria-hidden', 'true');
    chooser.remove();
    opened = false;
  };
  chooserClose.addEventListener('click', closeChooser);
  launcher.addEventListener('click', open);
  greetingClose.addEventListener('click', function () { greeting.remove(); });
  var overlay = document.createElement('div');
  overlay.setAttribute('data-chat-stub-overlay', '');
  overlay.hidden = true;
  document.body.append(greeting, wrapper, launcher);
  window.BX = window.BX || {};
  window.BX.SiteButton = window.BX.SiteButton || {};
  var buttons = { show: open };
  Object.defineProperty(buttons, 'isShown', { enumerable: true, get: function () { return opened; } });
  window.BX.SiteButton.buttons = buttons;
})();`;

export async function installThirdPartyGuard(
  page: Page,
  options: GuardOptions = {},
): Promise<ThirdPartyGuard> {
  const urls: string[] = [];
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
          body: options.reviewsWidgetBody ?? WIDGET_BODY_WITH_FOREIGN_PIXEL,
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
