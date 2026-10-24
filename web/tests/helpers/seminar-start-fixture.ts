import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

export const BEFORE = '2026-10-30T20:59:59Z';
export const AFTER = '2026-10-30T21:00:01Z';
export const TITLES = ['Граничный семинар', 'Последний сеанс курса', 'Следующий анонс', 'Четвёртый анонс'];

/** Real built routes from controlled content, without changing the pinned fixture. */
export async function serveSeminarStartFixture(mode: 'start' | 'month' | 'layout' = 'start') {
  const webRoot = resolve(import.meta.dirname, '../..');
  const sourceRoot = join(webRoot, '../fixtures/content-snapshot');
  const source = JSON.parse(readFileSync(join(sourceRoot, 'snapshot.json'), 'utf8'));
  const sourceTypes = source.content.types as Record<string, Record<string, unknown>[]>;
  const group = sourceTypes.course_groups.find((candidate) =>
    sourceTypes.seminars.some((seminar) => seminar.course_group_legacy_id === candidate.legacy_id));
  if (!group) throw new Error('Fixture needs an existing program and seminar');
  const institute = sourceTypes.institutes.find((candidate) => candidate.legacy_id === group.institute_legacy_id);
  const original = sourceTypes.seminars.find((seminar) => seminar.course_group_legacy_id === group.legacy_id);
  if (!institute || !original) throw new Error('Fixture route relations missing');
  const syntheticSeminars = TITLES.map((name, index) => ({
    ...original, legacy_id: `start-fixture-${index}`, slug: `start-fixture-${index}`, name,
    description_html: '<p>Описание сохраняется после начала семинара.</p>',
    description_text: 'Описание сохраняется после начала семинара.', images: [], teachers: [],
  }));
  const event = (id: number, seminarIndex: number, date: string, end = date) => {
    const entry = {
      id, status: 'active', name: `fixture-${id}`, seminar: { id: seminarIndex + 1, name: TITLES[seminarIndex], slug: syntheticSeminars[seminarIndex].slug },
      institute: { id: 1, name: institute.name, shortname: 'ИКПК' },
      startAt: `${date}T00:00:00.000Z`, endAt: `${end}T00:00:00.000Z`,
      teachers: [], image: null, isFree: true, isEventCollection: false, description: null,
      oldPrice: 0, newPrice: 0, city: { id: 1, name: 'Онлайн' },
      program: { id: 1, slug: group.slug, name: group.name },
      additionalText: `Сеанс ${id}`, duration: '8', registrationFormLink: `/registration-fixture-${id}`,
    };
    return entry;
  };
  const syntheticEntries = [
    event(61001, 0, '2026-10-31', '2026-11-02'), event(61002, 1, '2026-10-31'),
    event(61003, 2, '2026-11-02'),
    { ...event(61004, 0, '2026-11-04'), additionalText: 'Сеанс 61004. Начало в 18:00' },
    ...Array.from({ length: 23 }, (_, index) => event(61100 + index, 3, `2026-11-${String(index + 5).padStart(2, '0')}`)),
  ];
  if (mode === 'month') {
    // A patch in the short month, a strict city/month intersection, a city absent
    // from October, and >25 November rows keep every old gate branch observable.
    syntheticEntries[0] = { ...syntheticEntries[0], id: 900001, name: TITLES[0] };
    syntheticEntries.forEach((entry, index) => {
      entry.city = { id: index % 2 + 1, name: index % 2 === 0 ? 'Москва' : 'Онлайн' };
    });
    syntheticEntries.push({ ...event(61200, 2, '2026-11-28'), city: { id: 3, name: 'Казань' } });
  }
  // Existing layout and accessibility gates need the historical mix of 7, 1 and
  // 0 date panels. Use only a throwaway test snapshot; editorial CMS data
  // and the pinned production snapshot remain untouched.
  const layoutEntries = sourceTypes.schedule_entries;
  const entries = mode === 'layout' ? layoutEntries : syntheticEntries;
  const seminars = mode === 'layout' ? sourceTypes.seminars : syntheticSeminars;
  // Keep the two required homepage cards in this otherwise minimal snapshot.
  // Importing book-offers here loads the full data module during Playwright
  // test discovery, before its JSON loader is available.
  const homeOfferIds = new Set<number>([53, 49]);
  const types = mode === 'layout'
    ? { ...sourceTypes, schedule_entries: entries }
    : { ...Object.fromEntries(Object.keys(sourceTypes).map((name) => [name, []])),
        institutes: [{ ...institute, images: [] }], course_groups: [{ ...group, images: [] }],
        seminars, schedule_entries: entries,
        news: sourceTypes.news.filter((item) => homeOfferIds.has(Number(item.id))) };
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'ikpk-start-snapshot-'));
  mkdirSync(join(webRoot, '.astro'), { recursive: true });
  const buildRoot = mkdtempSync(join(webRoot, '.astro/ikpk-start-build-'));
  const outDir = join(buildRoot, 'dist');
  const cleanup = () => { rmSync(snapshotRoot, { recursive: true, force: true }); rmSync(buildRoot, { recursive: true, force: true }); };
  writeFileSync(join(snapshotRoot, 'snapshot.json'), JSON.stringify({
    ...source, referenceDate: mode === 'layout' ? source.referenceDate : '2026-10-30',
    content: { ...source.content, types },
  }));
  copyFileSync(join(sourceRoot, 'collapsible_panels.json'), join(snapshotRoot, 'collapsible_panels.json'));
  const built = spawnSync(process.execPath, [join(webRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', outDir], {
    cwd: webRoot, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      CONTENT_SNAPSHOT_DIR: snapshotRoot,
      SEMINAR_BUILD_NOW: mode === 'layout'
        ? `${source.referenceDate}T09:00:00+03:00`
        : '2026-10-30T09:00:00+03:00',
    },
  });
  if (built.error || built.status !== 0) {
    cleanup();
    throw new Error(`Controlled build failed (${built.status}): ${built.error ?? ''}\n${built.stdout}\n${built.stderr}`);
  }
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = createServer((request, response) => {
    let path = resolve(outDir, `.${new URL(request.url ?? '/', 'http://fixture').pathname}`);
    if (!path.startsWith(`${outDir}${sep}`) && path !== outDir) { response.writeHead(403).end(); return; }
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!existsSync(path)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(readFileSync(path));
  });
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  } catch (error) { cleanup(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a local port');
  const programPath = `/${institute.slug}/${group.slug}`;
  return {
    url: `http://127.0.0.1:${address.port}`, programPath, entries, outDir,
    detailPaths: seminars.map((seminar) => `${programPath}/${seminar.slug}`),
    close: async () => { await new Promise<void>((done) => server.close(() => done())); cleanup(); },
  };
}
