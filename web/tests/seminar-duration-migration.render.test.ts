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

async function render(override: string | null, publishedDefault: string | null, consumer: 'schedule' | 'seminar' | 'home' | 'home-table' | 'home-faculty' | 'preview' | 'preview-schedule') {
  const directory = mkdtempSync(join(tmpdir(), 'duration-migration-render-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ referenceDate: '2099-01-01', content: { types: {
    schedule_entries: [{ id: 1, name: 'Семинар', status: 'active', startAt: '2099-11-20T09:00:00Z', endAt: '2099-11-22T17:00:00Z',
      duration: override, seminar: { id: 10, slug: 'seminar', name: 'Семинар', duration: 'ЧЕРНОВИК 99 часов' },
      institute: { id: 1, name: 'Институт', shortname: 'ИКПК' }, program: { id: 1, slug: 'program', name: 'Программа' },
      city: 'Москва', isOnline: false, isFree: true, teachers: [{ id: 2, fullName: 'Ведущий семинара' }], registrationFormLink: '/registration', additionalText: '' }],
    seminars: [{ id: 10, slug: 'seminar', name: 'Семинар', course_group_legacy_id: 'program', duration: publishedDefault }],
    institutes: [{ id: 1, slug: 'institute', name: 'Институт' }], course_groups: [{ id: 1, slug: 'program', legacy_id: 'program', name: 'Программа', institute_legacy_id: 'institute' }], teachers: [], articles: [],
    static_pages: [{ slug: 'kontakty', legacy_id: 'kontakty', center_phone: '+78125550101', manager_phone: '+79815550202' }],
  } } }));
  process.env.CONTENT_SNAPSHOT_DIR = directory;
  vi.resetModules();
  const data = await import('../src/lib/data');
  const entries = data.getScheduleEntries();
  expect(entries).toHaveLength(1);
  const container = await AstroContainer.create({ astroConfig: { site: 'https://ikpk.su' } });
  const consumers = {
    schedule: () => import('../src/pages/raspisanie-i-tseny.astro'),
    seminar: () => import('../src/components/seminars/SeminarSchedulePanel.astro'),
    home: () => import('../src/components/home/sections/UpcomingModular.astro'),
    'home-table': () => import('../src/components/home/sections/UpcomingTable.astro'),
    'home-faculty': () => import('../src/components/home/sections/EventTeacher.astro'),
    preview: () => import('../src/pages/preview/[variant]/seminar.astro'),
    'preview-schedule': () => import('../src/pages/preview/[variant]/schedule.astro'),
  };
  const component = (await consumers[consumer]()).default;
  const html = await container.renderToString(component, {
    request: new Request(consumer === 'preview' ? 'https://ikpk.su/preview/modular/seminar' : consumer === 'preview-schedule' ? 'https://ikpk.su/preview/modular/schedule' : 'https://ikpk.su/raspisanie-i-tseny'),
    params: { variant: 'modular' },
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


for (const consumer of ['schedule', 'seminar', 'home', 'home-table', 'home-faculty', 'preview', 'preview-schedule'] as const) {
  it.each([null, ''])(`${consumer}: absent duration %j renders the exact fallback without fabricated hours`, async (duration) => {
    const html = await render(duration, null, consumer);
    expect(html.includes('Продолжительность не задана'), consumer).toBe(true);
    expect(html).not.toMatch(/\(\s*-\s*\)|\b\d+\s*час(?:а|ов)?/u);
    if (consumer === 'schedule') {
      expect(html).toContain('20.11.2099');
      expect(html).toContain('22.11.2099');
    }
  });
}
