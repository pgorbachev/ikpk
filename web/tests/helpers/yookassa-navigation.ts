import type { Page } from '@playwright/test';

type Capture = { urls: string[]; fallbackHref: string | null };

const captured = new WeakMap<Page, Capture>();

/**
 * Перехват document-навигации на confirmationUrl без шва в production-коде.
 * Запрос отменяется, URL берётся из route. Href ссылки-подстраховки снимается
 * MutationObserver'ом в странице: после abort документ уже не /oplata, а
 * локатор Playwright ждёт эту навигацию и не видит ссылку.
 */
export async function interceptYooKassaNavigation(page: Page): Promise<void> {
  const cap: Capture = { urls: [], fallbackHref: null };
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
    cap.urls.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.abort();
  });
}

export function yooKassaNavigationUrls(page: Page): string[] {
  return captured.get(page)?.urls ?? [];
}

export function yooKassaFallbackHref(page: Page): string | null {
  return captured.get(page)?.fallbackHref ?? null;
}

export async function gotoOplata(page: Page, path = '/oplata'): Promise<void> {
  const load = async () => {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 5_000 });
  };
  try {
    await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ERR_ABORTED|interrupted|Timeout/i.test(message)) throw error;
    await load();
  }
  if (!new URL(page.url()).pathname.replace(/\/$/, '').endsWith('/oplata')) {
    await load();
  }
}
