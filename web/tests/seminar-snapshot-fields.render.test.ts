import { describe, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DESCRIPTION = 'SQL_DEMO193_DESCRIPTION_MARKER';
const AUDIENCE = 'SQL_DEMO193_AUDIENCE_MARKER';
const LEARNING_MODE = 'SQL_DEMO193_LEARNING_MODE_MARKER';
const LEARNING_PLAN = 'SQL_DEMO193_LEARNING_PLAN_MARKER';
const RECOMMENDATIONS = 'SQL_DEMO193_RECOMMENDATIONS_MARKER';
const HOSTILE_DESCRIPTION = 'SQL_DEMO193_DESCRIPTION_HOSTILE_SENTINEL';
const HOSTILE_PROJECTION = 'SQL_DEMO193_PROJECTION_HOSTILE_SENTINEL';

const renderSeminarPage = async (): Promise<string> => {
  vi.doMock('../src/lib/data.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../src/lib/data.js')>(),
    getInstitutes: () => [],
    getCourseGroups: () => [],
    getSeminars: () => [],
    getScheduleEntries: () => [],
    getTeachers: () => [],
    getSnapshotReferenceDate: () => '2026-10-12',
  }));

  const routePath = join(
    import.meta.dirname,
    '..',
    'src',
    'pages',
    '[institute]',
    '[courseGroup]',
    '[seminar].astro',
  );
  const { default: SeminarPage } = await import(pathToFileURL(routePath).href);
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const html = await container.renderToString(SeminarPage as never, {
    request: new Request('https://ikpk.su/demo-institute/demo-program/demo-seminar'),
    props: {
      institute: { name: 'Synthetic institute', slug: 'demo-institute' },
      courseGroup: { name: 'Synthetic program', slug: 'demo-program' },
      seminar: {
        name: 'Synthetic seminar',
        slug: 'demo-seminar',
        description_html: `<p>${DESCRIPTION}</p><script>window.${HOSTILE_DESCRIPTION}=true</script><p onmouseover="${HOSTILE_DESCRIPTION}">description text</p>`,
        // The distinct fields model SQL -> CMS -> snapshot projection. The hostile
        // fragments exercise the page's existing cleanBodyHtml -> RichContent sink.
        full_text_html: `<h2>Для кого подойдет</h2><p>${AUDIENCE}</p><script>window.${HOSTILE_PROJECTION}=true</script><p onclick="${HOSTILE_PROJECTION}">audience text</p>`,
        learning_mode: `<p>${LEARNING_MODE}</p>`,
        learning_plan: `<p>${LEARNING_PLAN}</p>`,
        recommendations: `<p>${RECOMMENDATIONS}</p>`,
      },
    },
  });

  expect(html.length, 'canonical seminar page rendered no HTML').toBeGreaterThan(100);
  return html;
};

const occurrences = (text: string, needle: string): number =>
  [...text.matchAll(new RegExp(needle, 'g'))].length;

const sectionContains = (html: string, heading: string, marker: string, otherHeading: string): boolean => {
  const headingIndex = html.indexOf(heading);
  const markerIndex = html.indexOf(marker);
  const otherHeadingIndex = html.indexOf(otherHeading, headingIndex + heading.length);
  return headingIndex >= 0 && markerIndex > headingIndex &&
    (otherHeadingIndex < 0 || markerIndex < otherHeadingIndex);
};

const seminarBodyHtml = (html: string): string => {
  const rootStart = html.indexOf('<div data-safe-rich-content="seminar-body"');
  expect(rootStart, 'terminal RichContent sink did not render').toBeGreaterThanOrEqual(0);

  const openingTagEnd = html.indexOf('>', rootStart);
  let depth = 1;
  const divTags = /<\/?div\b[^>]*>/gi;
  divTags.lastIndex = openingTagEnd + 1;
  for (let match = divTags.exec(html); match; match = divTags.exec(html)) {
    if (match[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(openingTagEnd + 1, match.index);
  }

  throw new Error('terminal RichContent sink has no closing div');
};

describe('canonical hierarchical seminar page renders SQL snapshot fields', () => {
  it('renders the projected fields once in the body under their approved headings', async () => {
    const html = await renderSeminarPage();
    const body = seminarBodyHtml(html);

    expect.soft(occurrences(body, DESCRIPTION), 'existing description was lost or duplicated').toBe(1);
    expect.soft(occurrences(body, AUDIENCE), 'semantic audience was lost or duplicated').toBe(1);
    expect.soft(occurrences(body, LEARNING_MODE), 'learning_mode was lost or duplicated').toBe(1);
    expect.soft(occurrences(body, LEARNING_PLAN), 'learning_plan was lost or duplicated').toBe(1);
    expect.soft(occurrences(body, RECOMMENDATIONS), 'recommendations were lost or duplicated').toBe(1);

    expect.soft(
      sectionContains(body, 'Как проходит обучение', LEARNING_MODE, 'Учебный план'),
      'learning_mode is missing or appears under the wrong section heading',
    ).toBe(true);
    expect.soft(
      sectionContains(body, 'Учебный план', LEARNING_PLAN, 'Как проходит обучение'),
      'learning_plan is missing or appears under the wrong section heading',
    ).toBe(true);
  }, 20_000);

  it('keeps the existing description and sanitizes hostile rich HTML at the terminal sink', async () => {
    const html = await renderSeminarPage();
    const body = seminarBodyHtml(html);

    expect(body).toContain(DESCRIPTION);
    expect(body.toLowerCase()).not.toContain('<script');
    expect(body.toLowerCase()).not.toMatch(/on(?:click|mouseover)=/);
    expect(body).not.toContain(HOSTILE_DESCRIPTION);
    expect(body).not.toContain(HOSTILE_PROJECTION);
  }, 20_000);
});
