import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB_ROOT = join(import.meta.dirname, '../..');
const SNAPSHOT_SOURCE = join(WEB_ROOT, '..', 'fixtures', 'content-snapshot');
const REFERENCE_DATE = '2026-09-15';

type Snapshot = {
  referenceDate: string;
  content: { types: Record<string, unknown[]> };
  [key: string]: unknown;
};

export type FixturePage = {
  institute: { slug: string; legacy_id: string; name: string };
  group: { slug: string; legacy_id: string; institute_legacy_id: string; name: string };
  planned: { slug: string; name: string; course_group_legacy_id: string };
  empty: { slug: string; name: string; course_group_legacy_id: string };
  nextYear: { slug: string; name: string; course_group_legacy_id: string };
};

const tempDir = (prefix: string, parent = tmpdir()): string => mkdtempSync(join(parent, prefix));

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
  const nextYear = { ...planned, legacy_id: 'fixture-next-year', slug: 'fixture-next-year', name: 'Семинар следующего года' };
  return { institute, group, planned, empty, nextYear };
}

function scheduleEntry(
  page: FixturePage,
  id: number,
  status: string,
  startAt: string,
  endAt: string,
  city: string,
): Record<string, unknown> {
  const entry = {
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
    registrationFormLink: '/registration-fixture',
  };
  return entry;
}

export function buildSeminarDatesFixture() {
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
  fixtureTypes.seminars = [pages.planned, pages.empty, pages.nextYear];
  fixtureTypes.schedule_entries = [
    // Already started on the reference date: ongoing rows must not be offered.
    scheduleEntry(pages, 465, 'active', '2026-09-10', '2026-09-20', 'Дальний конец'),
    // Other started sessions stay excluded even while their end date is future.
    scheduleEntry(pages, 90, 'active', '2026-09-10', '2026-09-18', 'Якорный город'),
    // Duplicate date ranges must not leak back into offers through tie ordering.
    scheduleEntry(pages, 10, 'active', '2026-09-10', '2026-09-18', 'Москва'),
    scheduleEntry(pages, 9, 'active', '2026-09-10', '2026-09-18', 'Москва'),
    scheduleEntry(pages, 24, 'active', '2026-09-15', '2026-09-15', 'Поздний старт'),
    // Future records exercise one/two/three-month memberships and year labels.
    scheduleEntry(pages, 25, 'active', '2026-09-30', '2026-10-02', 'Два месяца'),
    scheduleEntry(pages, 26, 'active', '2026-10-31', '2026-12-02', 'Три месяца'),
    { ...scheduleEntry(pages, 27, 'active', '2027-01-05', '2027-01-05', 'Следующий год'),
      seminar: { id: 3, name: pages.nextYear.name, slug: pages.nextYear.slug } },
    scheduleEntry(pages, 1, 'cancelled', '2026-09-01', '2026-09-30', 'ОТМЕНЕНО'),
    scheduleEntry(pages, 2, 'active', '2026-09-01', '2026-09-14', 'ИСТЕКЛО'),
  ];

  const fixtureRoot = tempDir('ikpk-seminar-date-snapshot-');
  // Astro uses cwd/.astro/.prerender for outDir outside cwd; widget probes
  // already build there. Keep this fixture's prerender output in its own tree.
  const buildParent = join(WEB_ROOT, '.astro');
  mkdirSync(buildParent, { recursive: true });
  const buildRoot = tempDir('ikpk-seminar-date-build-', buildParent);
  const outDir = join(buildRoot, 'dist');
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
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(buildRoot, { recursive: true, force: true });
    throw new Error(
      `Controlled Astro build failed (${result.status ?? 'no exit status'}):\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { pages, outDir, close: () => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(buildRoot, { recursive: true, force: true });
  } };
}
