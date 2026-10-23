import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installThirdPartyGuard } from './helpers/third-party-guard';
import { TEMPLATES } from './helpers/templates';
import { loadPinnedSnapshot } from './helpers/pinned-snapshot';

for (const { name, width, height } of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 375, height: 812 },
]) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });
    test('confirmed dated seminar panel has no critical or serious accessibility violations', async ({ page }) => {
      const url = process.env.IKPK_LAYOUT_FIXTURE_URL;
      if (!url) throw new Error('Controlled layout fixture was not built');
      const path = TEMPLATES.find((template) => template.name === 'seminar-dated')?.path;
      if (!path) throw new Error('Dated seminar template is missing');
      await installThirdPartyGuard(page);
      await page.clock.install({ time: new Date(`${loadPinnedSnapshot().referenceDate}T00:00:00Z`) });
      expect((await page.goto(`${url}${path}`))?.status()).toBe(200);
      await expect(page.locator('[data-seminar-schedule-card]').first()).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('.contact-shell-map iframe')
        .exclude('.video-facade iframe')
        .analyze();
      const blocking = results.violations.filter((violation) =>
        violation.impact === 'critical' || violation.impact === 'serious');
      expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
    });
  });
}
