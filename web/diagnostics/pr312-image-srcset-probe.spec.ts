import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveStatic, type StaticSite } from '../tests/helpers/static-serve';
import { PROBE_CHAT_LOADER_SRC, buildProbe, type ProbeBuild } from '../tests/helpers/widget-probe-build';
import { installThirdPartyGuard } from '../tests/helpers/third-party-guard';

const logPath = process.env.PR312_IMAGE_SRCSET_PROBE_LOG;
const tinyGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let build: ProbeBuild;
let site: StaticSite;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(10 * 60 * 1000);
  if (!logPath) throw new Error('PR312_IMAGE_SRCSET_PROBE_LOG is required in the dedicated job');
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ event: 'fixture-build-start', timestamp: new Date().toISOString(),
    githubSha: process.env.GITHUB_SHA ?? null, pullRequestHeadSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null,
    nodeVersion: process.version, fixture: 'buildProbe smoke fixture; CI runs pinned npm build first' })}\n`);
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

for (const arm of ['tiny-gif', 'fixture-raster'] as const) {
  test(`srcset candidate image decode: ${arm}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const imageEvents: Record<string, unknown>[] = [];
    const responseRows: Record<string, unknown>[] = [];
    const responseBodies = new Map<string, Map<string, Promise<{ status: number; contentType: string; body: Buffer }>>>([
      ['fixture-load', new Map()], ['treatment-reload', new Map()],
    ]);
    const pageErrors: string[] = [];
    const imgEventKey = '__pr312SrcsetImageEvents';
    let responsePhase = 'fixture-load';
    let routeHit = false;
    const started = {
      event: 'start', arm, project: testInfo.project.name, title: testInfo.title, retry: testInfo.retry,
      timestamp: new Date().toISOString(), githubSha: process.env.GITHUB_SHA ?? null,
      pullRequestHeadSha: process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null,
      viewport: { width: 375, height: 812 },
      nodeVersion: process.version,
      chromiumVersion: page.context().browser()?.version() ?? null,
      sourceHashes: {
        probe: createHash('sha256').update(await readFile(new URL('./pr312-image-srcset-probe.spec.ts', import.meta.url))).digest('hex'),
        packageLock: createHash('sha256').update(await readFile(new URL('../package-lock.json', import.meta.url))).digest('hex'),
      },
    };
    await appendFile(logPath!, `${JSON.stringify(started)}\n`);

    let sourceSnapshot: Record<string, unknown> | null = null;
    let targetUrl: string | null = null;
    let treatmentResponse: Record<string, unknown> | null = null;
    let decodeError: string | null = null;
    let treatmentSnapshot: Record<string, unknown> | null = null;
    let testStatus: 'passed' | 'failed' = 'failed';

    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((key: string) => {
      const events: Record<string, unknown>[] = [];
      Object.defineProperty(window, key, { value: events, configurable: false });
      const record = (event: string, target: EventTarget | null) => {
        if (!(target instanceof HTMLImageElement)) return;
        events.push({ event, timestamp: new Date().toISOString(), documentId: `${performance.timeOrigin}`,
          src: target.src, currentSrc: target.currentSrc, srcset: target.srcset, sizes: target.sizes,
          complete: target.complete, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight });
      };
      document.addEventListener('load', (event) => record('load', event.target), true);
      document.addEventListener('error', (event) => record('error', event.target), true);
    }, imgEventKey);
    await installThirdPartyGuard(page, { chatLoaderSrc: PROBE_CHAT_LOADER_SRC });
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
    page.on('response', (response) => {
      if (!response.request().resourceType().includes('image')) return;
      const url = response.url();
      const phase = responsePhase;
      const task = response.body().then((body) => ({ status: response.status(),
        contentType: response.headers()['content-type'] ?? '', body }));
      responseBodies.get(phase)?.set(url, task);
      void task.then((row) => responseRows.push({ url, status: row.status, contentType: row.contentType,
        bytes: row.body.length, sha256: createHash('sha256').update(row.body).digest('hex'), phase }))
        .catch((error: unknown) => responseRows.push({ url, bodyError: String(error), phase }));
    });

    try {
      await page.goto(`${site.origin}/raspisanie-i-tseny`);
      const image = page.locator('[data-schedule-item] img').first();
      await image.waitFor({ state: 'attached' });
      await image.evaluate(async (img: HTMLImageElement) => img.decode());
      sourceSnapshot = await image.evaluate((img: HTMLImageElement) => ({ src: img.src, currentSrc: img.currentSrc,
        srcset: img.srcset, sizes: img.sizes, complete: img.complete,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        rect: (() => { const r = img.getBoundingClientRect(); return { width: r.width, height: r.height }; })() }));
      targetUrl = String(sourceSnapshot.currentSrc);
      const originalResponse = await responseBodies.get('fixture-load')?.get(targetUrl);
      if (!originalResponse || originalResponse.status !== 200 || !originalResponse.contentType.startsWith('image/'))
        throw new Error(`fixture srcset candidate had no successful image response: ${targetUrl}`);
      if (arm === 'fixture-raster' && (sourceSnapshot.naturalWidth as number) <= 0)
        throw new Error('fixture source image did not decode before the controlled reload');
      imageEvents.push(...await page.evaluate((key: string) =>
        (window as unknown as Record<string, Record<string, unknown>[]>)[key] ?? [], imgEventKey));

      const body = arm === 'tiny-gif' ? tinyGif : originalResponse.body;
      const contentType = arm === 'tiny-gif' ? 'image/gif' : originalResponse.contentType;
      responsePhase = 'treatment-reload';
      await page.route((url) => url.href === targetUrl, async (route) => {
        routeHit = true;
        await route.fulfill({ status: 200, contentType, body });
      });
      await page.reload();
      try {
        await image.evaluate(async (img: HTMLImageElement) => img.decode());
      } catch (error) {
        decodeError = error instanceof Error ? error.message : String(error);
      }
      treatmentSnapshot = await image.evaluate((img: HTMLImageElement) => ({ src: img.src, currentSrc: img.currentSrc,
        srcset: img.srcset, sizes: img.sizes, complete: img.complete,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        rect: (() => { const r = img.getBoundingClientRect(); return { width: r.width, height: r.height }; })() }));
      const actualTreatmentResponse = await responseBodies.get('treatment-reload')?.get(targetUrl);
      if (!routeHit || treatmentSnapshot.currentSrc !== targetUrl || !actualTreatmentResponse)
        throw new Error('controlled target URL was not requested and observed during treatment reload');
      treatmentResponse = { targetUrl, status: actualTreatmentResponse.status,
        contentType: actualTreatmentResponse.contentType, bytes: actualTreatmentResponse.body.length,
        sha256: createHash('sha256').update(actualTreatmentResponse.body).digest('hex'), treatment: arm };
      expect(actualTreatmentResponse.status).toBe(200);
      expect(actualTreatmentResponse.contentType).toBe(contentType);
      expect(actualTreatmentResponse.body.length).toBe(body.length);
      expect(treatmentResponse.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      if (arm === 'fixture-raster') {
        expect(decodeError).toBeNull();
        expect(treatmentSnapshot.naturalWidth).toBeGreaterThan(0);
      }
      testStatus = 'passed';
    } catch (error) {
      decodeError ??= error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally {
      imageEvents.push(...await page.evaluate((key: string) =>
        (window as unknown as Record<string, Record<string, unknown>[]>)[key] ?? [], imgEventKey).catch(() => []));
      const result = { ...started, event: 'finish', status: testStatus, sourceSnapshot, targetUrl, treatmentResponse,
        treatmentSnapshot, treatmentImageDecodeStatus: decodeError ? 'decode-rejected'
          : (Number(treatmentSnapshot?.naturalWidth) > 0 ? 'decoded' : 'natural-width-zero'),
        decodeError, responseRows, imageEvents, pageErrors, routeHit };
      await appendFile(logPath!, `${JSON.stringify(result)}\n`);
    }
  });
}
