import type { Page } from '@playwright/test';

export async function gotoAttachedPath(page: Page, path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const header = page.locator('header').first();
    if (await header.isVisible().catch(() => false)) {
      return;
    }

    const notFoundHeading = page.getByRole('heading', { name: '404: Not Found' });
    if (!(await notFoundHeading.isVisible().catch(() => false))) {
      await page.waitForLoadState('networkidle').catch(() => undefined);
      if (await header.isVisible().catch(() => false)) {
        return;
      }
    }

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  throw new Error(`Navigation failed after 3 attempts: ${path} (url: ${page.url()})`);
}
