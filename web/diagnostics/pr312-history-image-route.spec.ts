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

type Arm = 'natural-control' | 'forced-404' | 'valid-gif';
const cases: readonly { arm: Arm; iteration: number }[] = [
  { arm: 'natural-control', iteration: 0 },
  { arm: 'forced-404', iteration: 1 }, { arm: 'valid-gif', iteration: 1 },
  { arm: 'forced-404', iteration: 2 }, { arm: 'valid-gif', iteration: 2 },
  { arm: 'forced-404', iteration: 3 }, { arm: 'valid-gif', iteration: 3 },
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
      intervention: arm === 'natural-control' ? 'unmodified smoke fixture responses'
        : arm === 'forced-404' ? 'same-origin /media/ requests return controlled HTTP 404'
          : 'same-origin /media/ requests return valid 1x1 GIF',
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
    let attemptedCheckpoint = 'before-navigation';
    const reachedCheckpoints: string[] = [];
    const markCheckpoint = async (marker: string) => {
      attemptedCheckpoint = marker;
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail })), marker);
      reachedCheckpoints.push(marker);
    };

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
      if (arm !== 'natural-control') {
        const treatment = arm === 'forced-404'
          ? { status: 404, contentType: 'text/plain', body: 'PR312 controlled image failure' }
          : { status: 200, contentType: 'image/gif', body: gif };
        await page.route((url) => url.hostname === '127.0.0.1' && url.port === new URL(site.origin).port
          && url.pathname.startsWith('/media/'), async (route) => {
          await route.fulfill(treatment);
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
            mapRect: ['pageshow', 'pagehide', 'popstate', 'checkpoint'].includes(event) ? rect(map) : null,
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
        addEventListener('pr312-history-image-ab', (event) => record('checkpoint', (event as CustomEvent<string>).detail));
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
      attemptedCheckpoint = 'schedule-400-assigned';
      await port.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 400, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'schedule-400-assigned' }));
      });
      reachedCheckpoints.push('schedule-400-assigned');
      const entryUrl = page.url();
      await page.goto(`${site.origin}/kontakty`);
      const contactsPort = page.locator('[data-page-scrollport]');
      attemptedCheckpoint = 'contacts-700-assigned';
      await contactsPort.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 700, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'contacts-700-assigned' }));
      });
      reachedCheckpoints.push('contacts-700-assigned');
      await page.goto(entryUrl);
      await expect(port).toHaveCount(1);
      attemptedCheckpoint = 'schedule-1300-assigned';
      await port.evaluate((el: HTMLElement) => {
        el.scrollTo({ top: 1300, behavior: 'instant' });
        window.dispatchEvent(new CustomEvent('pr312-history-image-ab', { detail: 'schedule-1300-assigned' }));
      });
      reachedCheckpoints.push('schedule-1300-assigned');

      attemptedCheckpoint = 'back-1-navigation';
      await page.goBack();
      await expect(page).toHaveURL(/kontakty/);
      await markCheckpoint('back-1-contacts-url');
      attemptedCheckpoint = 'back-1-contacts-700';
      await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
        'back restores the intermediary entry position').toBe(700);
      await markCheckpoint('back-1-contacts-700');
      attemptedCheckpoint = 'back-2-navigation';
      await page.goBack();
      await expect(page).toHaveURL(entryUrl);
      await markCheckpoint('back-2-schedule-url');
      attemptedCheckpoint = 'back-2-schedule-400';
      await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
        'back restores the first same-URL entry position').toBe(400);
      await markCheckpoint('back-2-schedule-400');
      attemptedCheckpoint = 'forward-1-navigation';
      await page.goForward();
      await expect(page).toHaveURL(/kontakty/);
      await markCheckpoint('forward-1-contacts-url');
      attemptedCheckpoint = 'forward-1-contacts-700';
      await expect.poll(() => contactsPort.evaluate((el: HTMLElement) => el.scrollTop),
        'forward restores the intermediary entry position').toBe(700);
      await markCheckpoint('forward-1-contacts-700');
      attemptedCheckpoint = 'forward-2-navigation';
      await page.goForward();
      await expect(page).toHaveURL(entryUrl);
      await markCheckpoint('forward-2-schedule-url');
      attemptedCheckpoint = 'forward-2-schedule-1300';
      await expect.poll(() => port.evaluate((el: HTMLElement) => el.scrollTop),
        'forward restores the second same-URL entry position').toBe(1300);
      await markCheckpoint('forward-2-schedule-1300');
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
      const traceEvents = timeline.filter((event): event is Record<string, unknown> => Boolean(event && typeof event === 'object'));
      const imageEvidence = traceEvents.flatMap((event) => event.image && typeof event.image === 'object'
        ? [{ documentId: String(event.documentId), event: String(event.event),
          ...(event.image as { src: string; complete: boolean; naturalWidth: number; naturalHeight: number }) }]
        : []);
      const scheduleDocumentIds = [...new Set(traceEvents.filter((event) =>
        ['schedule-400-assigned', 'schedule-1300-assigned'].includes(String(event.marker)))
        .map((event) => String(event.documentId)))];
      const expectedStatus = arm === 'forced-404' ? 404 : 200;
      const expectedMediaResponses = arm === 'natural-control' ? [] : mediaResponses;
      const responseTreatmentValid = arm === 'natural-control' || (expectedMediaResponses.length > 0
        && expectedMediaResponses.every((response) => response.status === expectedStatus
          && (arm !== 'valid-gif' || response.contentType.startsWith('image/gif'))));
      const documentImageTreatmentValid = arm === 'natural-control' || (scheduleDocumentIds.length === 2
        && scheduleDocumentIds.every((documentId) => imageEvidence.some((image) => image.documentId === documentId
          && image.src.includes('/media/') && image.complete
          && mediaResponses.some((response) => response.url === image.src && response.status === expectedStatus)
          && (arm === 'forced-404'
            ? image.event === 'image-error' && image.naturalWidth === 0
            : image.event === 'image-load' && image.naturalWidth > 0 && image.naturalHeight > 0))));
      const imageArmValid = responseTreatmentValid && documentImageTreatmentValid;
      const timelineComplete = captureError === null && reachedCheckpoints.every((marker) => traceEvents.some((event) =>
        event.event === 'checkpoint' && event.marker === marker));
      const resultStatus = !timelineComplete || !imageArmValid ? 'invalid' : failure ? 'failed' : 'passed';
      const contactsEligible = reachedCheckpoints.includes('back-1-contacts-url');
      const scheduleEligible = reachedCheckpoints.includes('forward-2-schedule-url');
      const result = { ...start, event: 'finish', timestamp: new Date().toISOString(),
        status: resultStatus, historyAssertionStatus: failure ? 'failed' : 'passed', error: failure, captureError,
        attemptedCheckpoint, reachedCheckpoints, censoredAt: failure ? attemptedCheckpoint : null,
        symptomEligibility: { contacts700: contactsEligible, schedule1300: scheduleEligible },
        invalidReasons: [...(!timelineComplete ? ['incomplete-history-timeline'] : []),
          ...(!imageArmValid ? ['image-treatment-not-validated'] : [])],
        completeness: { timelineEvents: timeline.length, timelineComplete, mediaResponses: mediaResponses.length,
          mediaFailures: mediaFailures.length, responseTreatmentValid, documentImageTreatmentValid,
          scheduleDocumentIds, imageArmValid }, mediaResponses, mediaFailures, imageEvidence, timeline };
      await appendFile(logPath!, `${JSON.stringify(result)}\n`);
      if (failure === null) expect(timelineComplete && imageArmValid,
        'successful sequence must have complete reached checkpoints and a document-validated image treatment').toBe(true);
    }
  });
}
