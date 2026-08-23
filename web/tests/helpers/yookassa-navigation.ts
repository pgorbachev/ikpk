import type { Page } from '@playwright/test';

type Capture = {
  urls: string[];
  fallbackHref: string | null;
  pendingAborts: Set<Promise<void>>;
};

const captured = new WeakMap<Page, Capture>();

/**
 * Перехват document-навигации на confirmationUrl без шва в production-коде.
 * URL записывается только после requestfailed: иначе тест начинает следующий
 * goto, пока переход на ЮKassa ещё не отменён.
 */
export async function interceptYooKassaNavigation(page: Page): Promise<void> {
  const cap: Capture = { urls: [], fallbackHref: null, pendingAborts: new Set() };
  captured.set(page, cap);

  await page.exposeBinding('__recordYooKassaFallbackHref', (_source, href: string) => {
    cap.fallbackHref = href;
  });
  await page.addInitScript(() => {
    const record = (href: string) => {
      const fn = (window as unknown as { __recordYooKassaFallbackHref?: (h: string) => void })
        .__recordYooKassaFallbackHref;
      if (fn) void fn(href);
    };
    const scan = () => {
      const href = document.querySelector('[data-payment-confirmation-url]')?.getAttribute('href');
      if (href) record(href);
    };
    const start = () => {
      new MutationObserver(scan).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      scan();
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  });

  await page.route(/^https:\/\/yookassa\.test(?:\/|$)/, async (route) => {
    const url = route.request().url();
    const aborting = (async () => {
      const failed = page
        .waitForEvent('requestfailed', {
          predicate: (req) => req.url() === url,
          timeout: 5_000,
        })
        .catch(() => null);
      await route.abort();
      await failed;
      cap.urls.push(url);
    })();
    cap.pendingAborts.add(aborting);
    try {
      await aborting;
    } finally {
      cap.pendingAborts.delete(aborting);
    }
  });
}

export function yooKassaNavigationUrls(page: Page): string[] {
  return captured.get(page)?.urls ?? [];
}

export function yooKassaFallbackHref(page: Page): string | null {
  return captured.get(page)?.fallbackHref ?? null;
}

export async function waitForYooKassaNavigationSettled(page: Page): Promise<void> {
  const cap = captured.get(page);
  if (!cap || cap.pendingAborts.size === 0) return;
  await Promise.all([...cap.pendingAborts]);
}

export function isRetriableOplataLoadError(message: string): boolean {
  if (/Timeout/i.test(message)) return false;
  return /ERR_ABORTED|interrupted/i.test(message);
}

export function interruptedNavigationTarget(message: string): string | null {
  return message.match(/interrupted by another navigation to "(.*?)"/i)?.[1] ?? null;
}

function urlMatchesOplataPath(url: URL, path: string): boolean {
  const want = new URL(path, url.origin);
  const nowPath = url.pathname.replace(/\/$/, '');
  const wantPath = want.pathname.replace(/\/$/, '');
  if (nowPath !== wantPath && !nowPath.endsWith(wantPath)) return false;
  if (want.search) return url.search === want.search;
  return true;
}

function isTargetUrl(raw: string, path: string): boolean {
  try {
    return urlMatchesOplataPath(new URL(raw), path);
  } catch {
    return false;
  }
}

/**
 * Открыть /oplata новой навигацией. Не считать текущий URL достаточным:
 * после location.assign на ЮKassa адрес ещё /oplata, а документ уже рваный.
 * Timeout — не повод повторять goto.
 */
export async function gotoOplata(page: Page, path = '/oplata'): Promise<void> {
  await waitForYooKassaNavigationSettled(page);
  try {
    await page.evaluate(() => window.stop());
  } catch {
    /* chrome-error:// часто не даёт evaluate */
  }

  const attempt = async (): Promise<'done' | 'retry'> => {
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 5_000 });
      return 'done';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Timeout/i.test(message)) throw error;
      const interruptedTo = interruptedNavigationTarget(message);
      if (interruptedTo && isTargetUrl(interruptedTo, path)) {
        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
          return 'done';
        } catch {
          return 'retry';
        }
      }
      if (!isRetriableOplataLoadError(message)) throw error;
      await waitForYooKassaNavigationSettled(page);
      return 'retry';
    }
  };

  if ((await attempt()) === 'done') return;
  if ((await attempt()) === 'done') return;
  throw new Error(`gotoOplata: не удалось открыть ${path}`);
}
