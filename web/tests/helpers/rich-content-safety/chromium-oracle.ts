import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface OracleResult {
  mainFrameUrl: string;
  continuedRequests: string[];
  abortedAttempts: number;
  serialized: string;
  tagNames: string[];
  html: string;
}

export interface OracleHarness {
  parse(html: string): Promise<OracleResult>;
  close(): Promise<void>;
}

/**
 * Инертный Chromium oracle: about:blank заранее, DOMParser, abort всех request,
 * запрет goto/setContent/live innerHTML для hostile bytes.
 */
export async function openOracleHarness(): Promise<OracleHarness> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext();
  const continued: string[] = [];
  let aborted = 0;
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'about:blank') {
      return route.continue();
    }
    aborted += 1;
    return route.abort();
  });
  const page: Page = await context.newPage();
  page.on('requestfinished', (req) => {
    if (req.url() !== 'about:blank') continued.push(req.url());
  });
  await page.goto('about:blank');

  return {
    async parse(html: string): Promise<OracleResult> {
      const beforeUrl = page.url();
      const result = await page.evaluate((bytes) => {
        const doc = new DOMParser().parseFromString(bytes, 'text/html');
        const tags = Array.from(doc.querySelectorAll('*')).map((el) => el.tagName.toLowerCase());
        return {
          serialized: doc.documentElement?.outerHTML ?? '',
          tagNames: tags,
          html: doc.body?.innerHTML ?? '',
        };
      }, html);
      const afterUrl = page.url();
      if (afterUrl !== beforeUrl && afterUrl !== 'about:blank') {
        throw new Error(`oracle: main-frame URL изменился ${beforeUrl} → ${afterUrl}`);
      }
      if (continued.length > 0) {
        throw new Error(`oracle: продолженные запросы: ${continued.join(', ')}`);
      }
      return {
        mainFrameUrl: afterUrl,
        continuedRequests: [...continued],
        abortedAttempts: aborted,
        serialized: result.serialized,
        tagNames: result.tagNames,
        html: result.html,
      };
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
