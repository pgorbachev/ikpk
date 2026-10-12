import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attr, findAll, textOf, walk } from './helpers/dom';
import { MANAGER_PHONE, MANAGER_PHONE_HREF } from '../src/lib/navigation';

const WEB_ROOT = join(import.meta.dirname, '..');
const SNAPSHOT_SOURCE = join(WEB_ROOT, '..', 'fixtures', 'content-snapshot');
const REFERENCE_DATE = '2026-09-15';
const tempDirs: string[] = [];

type Snapshot = {
  referenceDate: string;
  content: { types: Record<string, unknown[]> };
  [key: string]: unknown;
};

type FixturePage = {
  institute: { slug: string; legacy_id: string; name: string };
  group: { slug: string; legacy_id: string; institute_legacy_id: string; name: string };
  planned: { slug: string; name: string; course_group_legacy_id: string };
  empty: { slug: string; name: string; course_group_legacy_id: string };
};

const tempDir = (prefix: string, parent = tmpdir()): string => {
  const dir = mkdtempSync(join(parent, prefix));
  tempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureRecords(snapshot: Snapshot): FixturePage {
  const groups = snapshot.content.types.course_groups as FixturePage['group'][];
  const seminars = snapshot.content.types.seminars as FixturePage['planned'][];
  const institutes = snapshot.content.types.institutes as FixturePage['institute'][];
  const group = groups.find((item) =>
    seminars.filter((seminar) => seminar.course_group_legacy_id === item.legacy_id).length >= 2,
  );
  if (!group) throw new Error('Pinned snapshot needs a program with at least two seminars');
  const institute = institutes.find((item) => item.legacy_id === group.institute_legacy_id);
  const [planned, empty] = seminars.filter(
    (seminar) => seminar.course_group_legacy_id === group.legacy_id,
  );
  if (!institute || !planned || !empty) throw new Error('Fixture program is missing its institute or seminars');
  return { institute, group, planned, empty };
}

function scheduleEntry(
  page: FixturePage,
  id: number,
  status: string,
  startAt: string,
  endAt: string,
  city: string,
): Record<string, unknown> {
  return {
    id,
    status,
    name: `Fixture event ${id}`,
    seminar: { id: 1, name: page.planned.name, slug: page.planned.slug },
    institute: { id: 1, name: page.institute.name, shortname: page.institute.name },
    startAt: `${startAt}T00:00:00.000Z`,
    endAt: `${endAt}T00:00:00.000Z`,
    teachers: [],
    image: null,
    isFree: true,
    isEventCollection: false,
    description: null,
    oldPrice: 0,
    newPrice: 0,
    city: { id, name: city },
    program: { id: 1, slug: page.group.slug, name: page.group.name },
    additionalText: '',
    duration: '',
    registrationFormLink: '',
  };
}

function renderedFixture(): { pages: FixturePage; outDir: string } {
  const source = JSON.parse(readFileSync(join(SNAPSHOT_SOURCE, 'snapshot.json'), 'utf8')) as Snapshot;
  const pages = fixtureRecords(source);
  const types = source.content.types;

  // The fixture is deliberately small: retain just the route records under test and
  // empty unrelated collections so the second build does not copy or process media.
  const fixtureTypes: Record<string, unknown[]> = Object.fromEntries(
    Object.keys(types).map((name) => [name, []]),
  );
  fixtureTypes.institutes = [pages.institute];
  fixtureTypes.course_groups = [pages.group];
  fixtureTypes.seminars = [pages.planned, pages.empty];
  fixtureTypes.schedule_entries = [
    // Active and ongoing on the reference date. It is the first-day winner even
    // though a later event has a shorter end date.
    scheduleEntry(pages, 465, 'active', '2026-09-10', '2026-09-20', 'Дальний конец'),
    // Same first day: the visible end date lets this tie-break be checked in HTML.
    scheduleEntry(pages, 90, 'active', '2026-09-10', '2026-09-18', 'Якорный город'),
    // Same date range; city and numeric-ID ties are represented in the rendered
    // schedule rows, while the program card intentionally exposes dates only.
    scheduleEntry(pages, 10, 'active', '2026-09-10', '2026-09-18', 'Москва'),
    scheduleEntry(pages, 9, 'active', '2026-09-10', '2026-09-18', 'Москва'),
    scheduleEntry(pages, 24, 'active', '2026-09-15', '2026-09-15', 'Поздний старт'),
    scheduleEntry(pages, 1, 'cancelled', '2026-09-01', '2026-09-30', 'ОТМЕНЕНО'),
    scheduleEntry(pages, 2, 'active', '2026-09-01', '2026-09-14', 'ИСТЕКЛО'),
  ];

  const fixtureRoot = tempDir('ikpk-seminar-date-snapshot-');
  // Astro uses cwd/.astro/.prerender for outDir outside cwd; widget probes
  // already build there. Keep this fixture's prerender output in its own tree.
  const buildParent = join(WEB_ROOT, '.astro');
  mkdirSync(buildParent, { recursive: true });
  const outDir = join(tempDir('ikpk-seminar-date-build-', buildParent), 'dist');
  writeFileSync(
    join(fixtureRoot, 'snapshot.json'),
    `${JSON.stringify({ ...source, referenceDate: REFERENCE_DATE, content: { types: fixtureTypes } })}\n`,
  );
  copyFileSync(join(SNAPSHOT_SOURCE, 'collapsible_panels.json'), join(fixtureRoot, 'collapsible_panels.json'));

  const astro = join(WEB_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
  const result = spawnSync(process.execPath, [astro, 'build', '--outDir', outDir], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CONTENT_SNAPSHOT_DIR: fixtureRoot },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Controlled Astro build failed (${result.status ?? 'no exit status'}):\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { pages, outDir };
}

const readBuiltPage = (outDir: string, path: string): string =>
  readFileSync(join(outDir, path, 'index.html'), 'utf8');

const normalizedText = (value: unknown): string => textOf(value).replace(/\s+/g, ' ').trim();

const within = (node: unknown, predicate: Parameters<typeof findAll>[1]) =>
  [...walk(node)].filter(predicate);

const cardFor = (html: string, title: string) =>
  findAll(html, (el) => attr(el, 'data-testid') === 'course-group-seminar-card').find((card) =>
    [...walk(card)].some((child) => child.tagName === 'h2' && normalizedText(child) === title),
  );

describe('controlled schedule fixture is reflected in built program and seminar pages', () => {
  it(
    'selects the nearest active event, keeps all active rows, and uses the shared manager contact only when empty',
    () => {
      const { pages, outDir } = renderedFixture();
      const programPath = `/${pages.institute.slug}/${pages.group.slug}`;
      const plannedPath = `${programPath}/${pages.planned.slug}`;
      const emptyPath = `${programPath}/${pages.empty.slug}`;
      const program = readBuiltPage(outDir, programPath);
      const plannedPage = readBuiltPage(outDir, plannedPath);
      const emptyPage = readBuiltPage(outDir, emptyPath);
      const plannedCard = cardFor(program, pages.planned.name);
      const emptyCard = cardFor(program, pages.empty.name);

      expect(plannedCard, 'program output must contain the controlled seminar card').toBeTruthy();
      expect(emptyCard, 'program output must contain the controlled empty seminar card').toBeTruthy();

      const nearest = within(plannedCard!, (el) => attr(el, 'data-testid') === 'seminar-nearest-date');
      expect(nearest.map(normalizedText)).toEqual(['10–18 сен']);
      expect(within(plannedCard!, (el) => attr(el, 'data-testid') === 'seminar-date-fallback')).toHaveLength(0);
      expect([...walk(plannedCard!)].some((el) => attr(el, 'href') === MANAGER_PHONE_HREF)).toBe(false);

      const rows = findAll(plannedPage, (el) => attr(el, 'data-seminar-schedule-card') !== null);
      const rowText = rows.map(normalizedText);
      expect(rows).toHaveLength(5);
      expect(rowText.some((text) => text.includes('Москва'))).toBe(true);
      expect(rowText.some((text) => text.includes('Дальний конец'))).toBe(true);
      expect(rowText.some((text) => text.includes('Поздний старт'))).toBe(true);
      expect(rowText.some((text) => text.includes('ОТМЕНЕНО') || text.includes('ИСТЕКЛО'))).toBe(false);
      expect(findAll(plannedPage, (el) => attr(el, 'data-testid') === 'seminar-schedule-empty')).toHaveLength(0);

      const emptyDateFallback = within(emptyCard!, (el) => attr(el, 'data-testid') === 'seminar-date-fallback');
      expect(emptyDateFallback.map(normalizedText)).toEqual(['Даты пока не назначены']);
      expect(within(emptyCard!, (el) => attr(el, 'data-testid') === 'seminar-nearest-date')).toHaveLength(0);
      const emptyCardPhone = within(emptyCard!, (el) => attr(el, 'href') === MANAGER_PHONE_HREF)[0];
      expect(emptyCardPhone && normalizedText(emptyCardPhone)).toContain(MANAGER_PHONE);

      const emptyPanel = findAll(emptyPage, (el) => attr(el, 'data-testid') === 'seminar-schedule-empty');
      expect(emptyPanel).toHaveLength(1);
      expect(normalizedText(emptyPanel[0])).toContain(MANAGER_PHONE);
      expect([...walk(emptyPanel[0])].some((el) => attr(el, 'href') === MANAGER_PHONE_HREF)).toBe(true);
      expect(findAll(emptyPage, (el) => attr(el, 'data-seminar-schedule-card') !== null)).toHaveLength(0);
    },
    150_000,
  );
});
