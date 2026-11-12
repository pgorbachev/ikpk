import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveStatic, type StaticSite } from '../tests/helpers/static-serve';
import { PROBE_CHAT_LOADER_SRC, buildProbe, type ProbeBuild } from '../tests/helpers/widget-probe-build';
import { installThirdPartyGuard } from '../tests/helpers/third-party-guard';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const logPath = process.env.PR312_HISTORY_IMAGE_AB_LOG;
let build: ProbeBuild;
let site: StaticSite;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(10 * 60 * 1000);
  if (!logPath) throw new Error('PR312_HISTORY_IMAGE_AB_LOG is required in the dedicated job');
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ event: 'fixture-build-start', timestamp: new Date().toISOString(),
    githubSha: process.env.GITHUB_SHA ?? null, pullRequestHeadSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null,
    nodeVersion: process.version, fixture: 'same buildProbe preview/chat stub as chat-entry-visibility.spec.ts; CI runs pinned npm build first' })}\n`);
  await mkdir(join(process.cwd(), '.astro'), { recursive: true });
  try {
    build = buildProbe('non-demo preview payment plus chat', {
      CHAT_LOADER_SRC: PROBE_CHAT_LOADER_SRC,
      PAYMENT_ROLE: 'preview',
      DEMO_FORMS: 'stub',
      DEMO_OUTPUT: undefined,
    }, { keepOnDisk: true });
    if (build.pages.size === 0 || !build.root) throw new Error('preview probe output is empty');
    execFileSync(join(process.cwd(), 'node_modules/.bin/pagefind'), ['--site', build.root], {
      cwd: process.cwd(), stdio: 'pipe', encoding: 'utf8',
    });
    site = await serveStatic(build.root);
    await appendFile(logPath, `${JSON.stringify({ event: 'fixture-ready', timestamp: new Date().toISOString(),
      root: build.root, origin: site.origin, pages: [...build.pages.keys()].length })}\n`);
  } catch (error) {
    await appendFile(logPath, `${JSON.stringify({ event: 'fixture-build-failure', timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.stack ?? error.message : String(error) })}\n`);
    throw error;
  }
});

test.afterAll(async () => {
  await site?.close();
  build?.dispose();
});

type Arm = 'natural-404' | 'valid-gif';
const cases: readonly { arm: Arm; iteration: number }[] = [
  { arm: 'natural-404', iteration: 1 }, { arm: 'valid-gif', iteration: 1 },
  { arm: 'natural-404', iteration: 2 }, { arm: 'valid-gif', iteration: 2 },
  { arm: 'natural-404', iteration: 3 }, { arm: 'valid-gif', iteration: 3 },
];

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

for (const { arm, iteration } of cases) {
  test(`${arm} iteration ${iteration}`, async ({ page }, testInfo) => {
    test.setTimeout(2 * 60 * 1000);
    const browser = page.context().browser();
    const packageVersion = async (name: string) => JSON.parse(
      await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
    ).version as string;
    const start = {
      event: 'start', arm, iteration, timestamp: new Date().toISOString(),
      githubSha: process.env.GITHUB_SHA ?? null,
      pullRequestHeadSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null,
      project: testInfo.project.name, title: testInfo.title, retry: testInfo.retry,
      nodeVersion: process.version, playwrightTestVersion: await packageVersion('@playwright/test'),
      playwrightVersion: await packageVersion('playwright'), playwrightCoreVersion: await packageVersion('playwright-core'),
      chromiumVersion: browser?.version() ?? null,
      projectDefaultViewport: testInfo.project.use.viewport ?? null,
      effectiveViewport: { width: 375, height: 812 },
      intervention: arm === 'valid-gif' ? 'same-origin /media/ requests return valid 1x1 GIF' : 'unmodified static fixture responses',
      assertions: 'same sequence and exact restore assertions as original history test',
      sourceHashes: {
        diagnostic: await sha256(new URL('./pr312-history-image-route.spec.ts', import.meta.url).pathname),
        originalTest: await sha256(new URL('../tests/chat-entry-visibility.spec.ts', import.meta.url).pathname),
        fixtureBuilder: await sha256(new URL('../tests/helpers/widget-probe-build.ts', import.meta.url).pathname),
        staticServer: await sha256(new URL('../tests/helpers/static-serve.ts', import.meta.url).pathname),
        thirdPartyGuard: await sha256(new URL('../tests/helpers/third-party-guard.ts', import.meta.url).pathname),
        packageLock: await sha256(new URL('../package-lock.json', import.meta.url).pathname),
      },
      fixtureHtmlHashes: Object.fromEntries([...build.pages.entries()]
        .filter(([path]) => /(?:raspisanie-i-tseny|kontakty)\/index\.html$/.test(path))
        .map(([path, html]) => [path, createHash('sha256').update(html).digest('hex')])),
    };
    await appendFile(logPath!, `${JSON.stringify(start)}\n`);
    const mediaResponses: { url: string; status: number; contentType: string; treatment: Arm }[] = [];
    const mediaFailures: { url: string; error: string }[] = [];
    const traceKey = '__pr312HistoryImageAB';
    let failure: string | null = null;

    try {
      await installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/media/')) {
          mediaResponses.push({ url: response.url(), status: response.status(),
            contentType: response.headers()['content-type'] ?? '', treatment: arm });
        }
      });
      page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/media/'))
          mediaFailures.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' });
      });
      if (arm === 'valid-gif') {
        await page.route((url) => url.hostname === '127.0.0.1' && url.port === new URL(site.origin).port
          && url.pathname.startsWith('/media/'), async (route) => {
          await route.fulfill({ status: 200, contentType: 'image/gif', body: gif });
        });
      }
      await page.addInitScript((key: string) => {
        const record = (event: string, marker?: string, image?: Record<string, unknown>) => {
          const port = document.querySelector<HTMLElement>('[data-page-scrollport]');
          const state = history.state && typeof history.state === 'object' ? history.state as Record<string, unknown> : {};
          const saved = state.__ikpkChatPageScroll;
          const map = document.querySelector<HTMLElement>('.contact-shell-map');
          const rect = (element: Element | null) => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
          };
          const item = { event, marker: marker ?? null, timestamp: new Date().toISOString(),
            documentId: String(performance.timeOrigin), url: location.href, historyLength: history.length,
            savedEntry: saved ?? null, scrollTop: port?.scrollTop ?? null, scrollHeight: port?.scrollHeight ?? null,
            clientWidth: port?.clientWidth ?? null, viewportWidth: innerWidth,
            mapRect: ['pageshow', 'pagehide', 'popstate', 'scroll-assignment'].includes(event) ? rect(map) : null,
            image: image ?? null };
          try {
            const items = JSON.parse(sessionStorage.getItem(key) || '[]') as unknown[];
            items.push(item);
            sessionStorage.setItem(key, JSON.stringify(items));
          } catch { /* log capture is best effort and shared by both arms */ }
        };
        addEventListener('pageshow', () => record('pageshow'));
        addEventListener('pagehide', () => record('pagehide'));
        addEventListener('popstate', () => queueMicrotask(() => record('popstate')));
        addEventListener('pr312-history-image-ab', (event) => record('scroll-assignment', (event as CustomEvent<string>).detail));
        addEventListener('load', (event) => {
          if (event.target instanceof HTMLImageElement && event.target.currentSrc.includes('/media/')) {
            const image = event.target;
            record('image-load', image.currentSrc, { src: image.currentSrc, complete: image.complete,
              naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
          }
        }, true);
        addEventListener('error', (event) => {
          if (event.target instanceof HTMLImageElement && (event.target.currentSrc || event.target.src).includes('/media/')) {
            const image = event.target;
            record('image-error', image.currentSrc || image.src, { src: image.currentSrc || image.src,
              complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
          }
        }, true);
      }, traceKey);
      await page.setViewportSize({ width: 375, height: 812 });
      const scheduleUrl = `${site.origin}/raspisanie-i-tseny`;
      await page.goto(scheduleUrl);
      const port = page.locator('[data-page-scrollport]');
      await expect(port).toHaveCount(1);
      await port.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 400, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'schedule-400-assigned' }));
      });
      const entryUrl = page.url();
      await page.goto(`${site.origin}/kontakty`);
      const contactsPort = page.locator('[data-page-scrollport]');
      await contactsPort.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 700, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'contacts-700-assigned' }));
      });
      await page.goto(entryUrl);
      await expect(port).toHaveCount(1);
      await port.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 1300, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'schedule-1300-assigned' }));
      });

      await page.goBack();
      await expect(page).toHaveURL(/kontakty/);
      await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
        'back restores the intermediary entry position').toBe(700);
      await page.goBack();
      await expect(page).toHaveURL(entryUrl);
      await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
        'back restores the first same-URL entry position').toBe(400);
      await page.goForward();
      await expect(page).toHaveURL(/kontakty/);
      await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
        'forward restores the intermediary entry position').toBe(700);
      await page.goForward();
      await expect(page).toHaveURL(entryUrl);
      await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
        'forward restores the second same-URL entry position').toBe(1300);
      if (arm === 'natural-404') {
        expect(mediaResponses.length, 'A must observe fixture media responses').toBeGreaterThan(0);
        expect(mediaResponses.every((response) => response.status === 404), 'A must preserve the fixture 404 responses').toBe(true);
      } else {
        const currentImages = await page.locator('[data-schedule-item] img').evaluateAll((images) => images.map((image) => ({
          src: (image as HTMLImageElement).currentSrc,
          complete: (image as HTMLImageElement).complete,
          naturalWidth: (image as HTMLImageElement).naturalWidth,
          naturalHeight: (image as HTMLImageElement).naturalHeight,
        })));
        expect(mediaResponses.length, 'B must intercept at least one fixture media request').toBeGreaterThan(0);
        expect(mediaResponses.every((response) => response.status === 200
          && response.contentType.startsWith('image/gif')), 'B responses must carry the valid GIF treatment').toBe(true);
        expect(currentImages.some((image) => image.src.includes('/media/') && image.complete
          && image.naturalWidth > 0 && image.naturalHeight > 0), 'B must decode an actual schedule image element').toBe(true);
      }
    } catch (error) {
      failure = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally {
      let timeline: unknown[] = [];
      let captureError: string | null = null;
      try {
        timeline = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) || '[]') as unknown[], traceKey);
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
      const decodedImages = timeline.flatMap((event) => event && typeof event === 'object'
        && (event as { image?: unknown }).image && typeof (event as { image: unknown }).image === 'object'
        ? [(event as { image: { src: string; complete: boolean; naturalWidth: number; naturalHeight: number } }).image]
        : []);
      const imageArmValid = arm === 'natural-404'
        ? mediaResponses.length > 0 && mediaResponses.every((response) => response.status === 404)
        : mediaResponses.length > 0
          && mediaResponses.every((response) => response.status === 200 && response.contentType.startsWith('image/gif'))
          && decodedImages.some((image) => image.src.includes('/media/') && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
      const markers = ['schedule-400-assigned', 'contacts-700-assigned', 'schedule-1300-assigned'];
      const timelineComplete = captureError === null && markers.every((marker) => timeline.some((event) =>
        event && typeof event === 'object' && (event as { marker?: string }).marker === marker))
        && timeline.filter((event) => event && typeof event === 'object'
          && (event as { event?: string }).event === 'pagehide').length >= 6
        && new Set(timeline.filter((event) => event && typeof event === 'object')
          .map((event) => (event as { documentId?: string }).documentId).filter(Boolean)).size >= 3;
      const resultStatus = !timelineComplete || !imageArmValid ? 'invalid' : failure ? 'failed' : 'passed';
      const result = { ...start, event: 'finish', timestamp: new Date().toISOString(),
        status: resultStatus, historyAssertionStatus: failure ? 'failed' : 'passed', error: failure, captureError,
        invalidReasons: [...(!timelineComplete ? ['incomplete-history-timeline'] : []),
          ...(!imageArmValid ? ['image-treatment-not-validated'] : [])],
        completeness: { timelineEvents: timeline.length, timelineComplete, mediaResponses: mediaResponses.length,
          mediaFailures: mediaFailures.length, imageArmValid }, mediaResponses, mediaFailures, timeline };
      await appendFile(logPath!, `${JSON.stringify(result)}\n`);
      if (failure === null) expect(timelineComplete, 'successful sequence must include all three assigned positions and navigation lifecycle').toBe(true);
    }
  });
}
