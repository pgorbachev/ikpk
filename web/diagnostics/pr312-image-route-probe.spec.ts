import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { installThirdPartyGuard } from '../tests/helpers/third-party-guard';
import { buildProbe, PROBE_CHAT_LOADER_SRC, type ProbeBuild } from '../tests/helpers/widget-probe-build';
import { serveStatic, type StaticSite } from '../tests/helpers/static-serve';

let build: ProbeBuild;
let site: StaticSite;

test.beforeAll(async () => {
  test.setTimeout(10 * 60 * 1000);
  build = buildProbe('non-demo preview payment plus chat', {
    CHAT_LOADER_SRC: PROBE_CHAT_LOADER_SRC,
    PAYMENT_ROLE: 'preview',
    DEMO_FORMS: 'stub',
    DEMO_OUTPUT: undefined,
  }, { keepOnDisk: true });
  execFileSync(join(process.cwd(), 'node_modules/.bin/pagefind'), ['--site', build.root!], {
    cwd: process.cwd(),
    stdio: 'pipe',
    encoding: 'utf8',
  });
  site = await serveStatic(build.root!);
});

test.afterAll(async () => {
  await site?.close();
  build?.dispose();
});

test('a local fixture image response decodes in the guarded mobile browser', async ({ page, browser }, testInfo) => {
  const logPath = process.env.PR312_ROUTE_PROBE_LOG;
  if (!logPath) {
    test.skip(true, 'Only run in the dedicated PR 312 route probe job');
    return;
  }

  await mkdir(dirname(logPath), { recursive: true });
  const sourceFiles = [
    'tests/helpers/widget-probe-build.ts',
    'tests/helpers/static-serve.ts',
    'tests/helpers/third-party-guard.ts',
    'src/pages/raspisanie-i-tseny.astro',
    'src/components/schedule/ScheduleListing.astro',
    'src/components/schedule/ScheduleEventCard.astro',
    'package-lock.json',
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [
    path,
    createHash('sha256').update(await readFile(path)).digest('hex'),
  ] as const)));
  const version = async (name: string) => JSON.parse(
    await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
  ).version as string;
  const metadata = {
    event: 'start',
    timestamp: new Date().toISOString(),
    githubSha: process.env.GITHUB_SHA ?? null,
    pullRequestHeadSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null,
    nodeVersion: process.version,
    playwrightTestVersion: await version('@playwright/test'),
    playwrightVersion: await version('playwright'),
    playwrightCoreVersion: await version('playwright-core'),
    chromiumVersion: browser.version(),
    project: testInfo.project.name,
    viewport: { width: 375, height: 812 },
    sourceHashes,
    fixture: {
      root: build.root,
      origin: site.origin,
      schedulePages: [...build.pages.entries()]
        .filter(([path]) => path.includes('raspisanie-i-tseny'))
        .map(([path, html]) => ({ path, htmlSha256: createHash('sha256').update(html).digest('hex') })),
      role: 'preview',
      chatLoader: 'probe stub',
      paymentForms: 'stub',
    },
  };
  await appendFile(logPath, `${JSON.stringify(metadata)}\n`);

  const routeResponses: { url: string; status: number; contentType: string; bytes: number; signature: string }[] = [];
  const responseTasks: Promise<void>[] = [];
  const decodeEvents: Record<string, unknown>[] = [];
  const routeHits: string[] = [];
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  let probeUrl: string | null = null;
  let failure: string | null = null;

  try {
    await installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/media/')) return;
      responseTasks.push(response.body().then((body) => {
        routeResponses.push({ url: response.url(), status: response.status(),
          contentType: response.headers()['content-type'] ?? '', bytes: body.length,
          signature: body.subarray(0, 8).toString('hex') });
      }));
    });
    await page.route((url) => url.hostname === '127.0.0.1' && url.port === new URL(site.origin).port
      && url.pathname.startsWith('/media/'), async (route) => {
      routeHits.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'image/gif', body: gif });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${site.origin}/raspisanie-i-tseny`);
    const firstImage = page.locator('[data-schedule-item] img').first();
    await expect(firstImage, 'the built schedule fixture exposes an image to probe').toHaveCount(1);
    const source = await firstImage.evaluate((image: HTMLImageElement) => image.currentSrc || image.src);
    const target = new URL(source);
    target.searchParams.set('pr312DecodeProbe', '1');
    probeUrl = target.toString();
    const decoded = await page.evaluate(async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, src: image.currentSrc };
    }, probeUrl);
    decodeEvents.push({ type: 'image-decode', ...decoded });

    expect(decoded.complete).toBe(true);
    expect(decoded.naturalWidth).toBeGreaterThan(0);
    expect(decoded.naturalHeight).toBeGreaterThan(0);
    await expect.poll(() => routeHits.includes(probeUrl!)).toBe(true);
    await expect.poll(() => routeResponses.some((response) => response.url === probeUrl)).toBe(true);
    const exactResponse = routeResponses.find((response) => response.url === probeUrl);
    expect(exactResponse).toMatchObject({ status: 200, contentType: 'image/gif', bytes: 42, signature: '4749463839610100' });
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await Promise.all(responseTasks);
    const exactResponse = routeResponses.find((response) => response.url === probeUrl);
    const result = {
      event: 'finish',
      timestamp: new Date().toISOString(),
      status: failure === null ? 'passed' : 'failed',
      failure,
      probeUrl,
      routeHits,
      routeResponses,
      exactResponse: exactResponse ?? null,
      expectedImage: { mime: 'image/gif', bytes: gif.length, signature: gif.subarray(0, 8).toString('hex') },
      decodeEvents,
    };
    await appendFile(logPath, `${JSON.stringify(result)}\n`);
    await testInfo.attach('pr312-image-route-probe.jsonl', { path: logPath, contentType: 'application/x-ndjson' });
  }
});
