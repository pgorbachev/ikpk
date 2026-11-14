import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

const originalSnapshot = process.env.CONTENT_SNAPSHOT_DIR;
const temporaryDirectories: string[] = [];
afterEach(() => {
  if (originalSnapshot === undefined) delete process.env.CONTENT_SNAPSHOT_DIR;
  else process.env.CONTENT_SNAPSHOT_DIR = originalSnapshot;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.resetModules();
});

async function render(override: string | null, publishedDefault: string | null, consumer: 'schedule' | 'seminar' | 'home') {
  const directory = mkdtempSync(join(tmpdir(), 'duration-migration-render-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ referenceDate: '2099-01-01', content: { types: {
    schedule_entries: [{ id: 1, name: 'Семинар', status: 'active', startAt: '2099-11-20T09:00:00Z', endAt: '2099-11-22T17:00:00Z',
      duration: override, seminar: { id: 10, slug: 'seminar', name: 'Семинар', duration: 'ЧЕРНОВИК 99 часов' },
      institute: { id: 1, name: 'Институт', shortname: 'ИКПК' }, program: { id: 1, slug: 'program', name: 'Программа' },
      city: 'Москва', isOnline: false, isFree: true, teachers: [], registrationFormLink: '/registration', additionalText: '' }],
    seminars: [{ id: 10, slug: 'seminar', name: 'Семинар', duration: publishedDefault }],
    institutes: [{ id: 1, slug: 'institute', name: 'Институт' }], course_groups: [], teachers: [], articles: [], static_pages: [],
  } } }));
  process.env.CONTENT_SNAPSHOT_DIR = directory;
  vi.resetModules();
  const data = await import('../src/lib/data');
  const entries = data.getScheduleEntries();
  expect(entries).toHaveLength(1);
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const component = consumer === 'schedule'
    ? (await import('../src/pages/raspisanie-i-tseny.astro')).default
    : consumer === 'home'
      ? (await import('../src/components/home/sections/UpcomingModular.astro')).default
      : (await import('../src/components/seminars/SeminarSchedulePanel.astro')).default;
  const html = await container.renderToString(component, {
    request: new Request('https://ikpk.su/raspisanie-i-tseny'),
    props: { rows: entries.map(entry => ({ entry, teachers: [] })) },
  });
  expect(html).not.toContain('ЧЕРНОВИК');
  return html.replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
}

for (const consumer of ['schedule', 'seminar'] as const) {
  it(`${consumer}: moving numeric legacy hours to an inherited default preserves day and hour labels`, async () => {
    const before = await render('36', null, consumer);
    expect(before).toContain('3 дня (36 часов)');
    const after = await render(null, '36 часов', consumer);
    expect(after.includes('3 дня (36 часов)'), `${consumer}: inherited hours lost the legacy day label`).toBe(true);
  });

  it(`${consumer}: inherited free text stays literal without invented hour suffix`, async () => {
    const html = await render(null, 'две учебные недели', consumer);
    expect(html).toContain('две учебные недели');
    expect(html).not.toMatch(/две учебные недели\s*(?:час|ч\b)/u);
  });
}

it('home retains the number and unit of inherited hours without borrowing draft data', async () => {
  const before = await render('36', null, 'home');
  expect(before).toContain('36 ч');
  const after = await render(null, '36 часов', 'home');
  expect(after).toMatch(/36 (?:ч|часов)(?=<|\s)/u);
  expect(after).not.toContain('ЧЕРНОВИК');
});
