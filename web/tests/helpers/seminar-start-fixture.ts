import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { startTimeFingerprint } from '../../../cms/src/seminar-management/start-time';

export const BEFORE = '2026-10-31T15:59:59Z';
export const AFTER = '2026-10-31T16:00:01Z';
export const TITLES = ['Граничный семинар', 'Последний сеанс курса', 'Следующий анонс', 'Четвёртый анонс'];

/** Real built routes from controlled content, without changing the pinned fixture. */
export async function serveSeminarStartFixture() {
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
  const seminars = TITLES.map((name, index) => ({
    ...original, legacy_id: `start-fixture-${index}`, slug: `start-fixture-${index}`, name,
    description_html: '<p>Описание сохраняется после начала семинара.</p>',
    description_text: 'Описание сохраняется после начала семинара.', images: [], teachers: [],
  }));
  const event = (id: number, seminarIndex: number, date: string, end = date) => {
    const entry = {
      id, status: 'active', name: `fixture-${id}`, seminar: { id: seminarIndex + 1, name: TITLES[seminarIndex], slug: seminars[seminarIndex].slug },
      institute: { id: 1, name: institute.name, shortname: 'ИКПК' },
      startAt: `${date}T00:00:00.000Z`, endAt: `${end}T00:00:00.000Z`,
      startsAtInstant: `${date}T16:00:00Z`, startTimeZone: 'Europe/Moscow', startTimeConfirmed: true,
      teachers: [], image: null, isFree: true, isEventCollection: false, description: null,
      oldPrice: 0, newPrice: 0, city: { id: 1, name: 'Онлайн' },
      program: { id: 1, slug: group.slug, name: group.name },
      additionalText: `Сеанс ${id}`, duration: '8', registrationFormLink: `/registration-fixture-${id}`,
    };
    return { ...entry, startTimeConfirmation: startTimeFingerprint(entry) };
  };
  const entries = [
    event(61001, 0, '2026-10-31', '2026-11-02'), event(61002, 1, '2026-10-31'),
    event(61003, 2, '2026-11-02'), event(61004, 0, '2026-11-04'),
    ...Array.from({ length: 23 }, (_, index) => event(61100 + index, 3, `2026-11-${String(index + 5).padStart(2, '0')}`)),
  ];
  const types = Object.fromEntries(Object.keys(sourceTypes).map((name) => [name, []]));
  Object.assign(types, { institutes: [{ ...institute, images: [] }], course_groups: [{ ...group, images: [] }], seminars, schedule_entries: entries });
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'ikpk-start-snapshot-'));
  mkdirSync(join(webRoot, '.astro'), { recursive: true });
  const buildRoot = mkdtempSync(join(webRoot, '.astro/ikpk-start-build-'));
  const outDir = join(buildRoot, 'dist');
  const cleanup = () => { rmSync(snapshotRoot, { recursive: true, force: true }); rmSync(buildRoot, { recursive: true, force: true }); };
  writeFileSync(join(snapshotRoot, 'snapshot.json'), JSON.stringify({ ...source, referenceDate: '2026-10-31', content: { types } }));
  copyFileSync(join(sourceRoot, 'collapsible_panels.json'), join(snapshotRoot, 'collapsible_panels.json'));
  const built = spawnSync(process.execPath, [join(webRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', outDir], {
    cwd: webRoot, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, CONTENT_SNAPSHOT_DIR: snapshotRoot },
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
    url: `http://127.0.0.1:${address.port}`, programPath,
    detailPaths: seminars.map((seminar) => `${programPath}/${seminar.slug}`),
    close: async () => { await new Promise<void>((done) => server.close(() => done())); cleanup(); },
  };
}
