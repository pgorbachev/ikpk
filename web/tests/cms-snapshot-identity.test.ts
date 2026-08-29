import { describe, it, expect } from 'vitest';
import {
  MODULES,
  loadModule,
  type Snapshot,
  type SnapshotContent,
  type SnapshotModule,
} from './helpers/cms-content-publication-contract';

// Спека: `openspec/changes/cms-content-publication/specs/cms-content-source/spec.md`,
// требование «Снимок создаётся один раз и идентифицируется своим содержимым».
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: prebuild-шага снимка и модуля идентификаторов ещё нет (tasks.md 3.1,
// 3.2). Каждый тест загружает модуль внутри себя, поэтому краснеет своим именем.

const article = (slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  title: `Статья ${slug}`,
  body: `<p>Тело ${slug}</p>`,
  page_title: `Заголовок ${slug}`,
  page_description: `Описание ${slug}`,
  image: `/media/${slug}.jpg`,
  ...extra,
});

const baseContent = (): SnapshotContent => ({
  types: {
    articles: [article('alpha'), article('beta')],
    seminars: [{ slug: 'sem-1', title: 'Семинар', program: 'prog-1', order: 1 }],
    programs: [{ slug: 'prog-1', title: 'Программа', institute: 'inst-1' }],
    institutes: [{ slug: 'inst-1', title: 'Институт' }],
    teachers: [{ slug: 'teach-1', name: 'Преподаватель', institute: 'inst-1' }],
  },
  media: [
    { ref: '/media/alpha.jpg', contentId: 'sha256:aaaa' },
    { ref: '/media/beta.jpg', contentId: 'sha256:bbbb' },
  ],
});

/** Тот же контент, отданный в другом порядке, другим разбиением и с другим порядком ключей. */
const reorderedContent = (): SnapshotContent => {
  const base = baseContent();
  const reorderKeys = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).reverse());
  return {
    types: Object.fromEntries(
      Object.entries(base.types)
        .reverse()
        .map(([type, records]) => [type, [...records].reverse().map(reorderKeys)]),
    ),
    media: [...base.media].reverse(),
  };
};

const snapshotModule = (): Promise<SnapshotModule> => loadModule<SnapshotModule>(MODULES.snapshot);

describe('снимок: два идентификатора', () => {
  // Сценарий: снимки отличаются только опорной датой
  it('отпечаток контента не зависит от опорной даты, идентификатор снимка — зависит', async () => {
    const mod = await snapshotModule();
    const content = baseContent();
    const fingerprint = mod.contentFingerprint(content);

    const yesterday = mod.snapshotId({ fingerprint, referenceDate: '2026-08-23' });
    const today = mod.snapshotId({ fingerprint, referenceDate: '2026-08-24' });

    expect(mod.contentFingerprint(baseContent())).toBe(fingerprint);
    expect(yesterday).not.toBe(today);
  });

  // Сценарий: отпечаток не зависит от порядка в ответе
  it('перестановка записей, страниц и ключей отпечаток не меняет', async () => {
    const mod = await snapshotModule();
    expect(mod.contentFingerprint(reorderedContent())).toBe(mod.contentFingerprint(baseContent()));
  });

  // Тот же сценарий, обратная сторона: осмысленный порядок входит значением поля.
  it('осмысленный порядок обучения меняет отпечаток, потому что это значение поля', async () => {
    const mod = await snapshotModule();
    const changed = baseContent();
    (changed.types.seminars[0] as Record<string, unknown>).order = 2;
    expect(mod.contentFingerprint(changed)).not.toBe(mod.contentFingerprint(baseContent()));
  });

  // Сценарий: снимки отличаются одним медиафайлом
  it('различие содержимого одного медиафайла меняет и отпечаток, и идентификатор снимка', async () => {
    const mod = await snapshotModule();
    const changed = baseContent();
    changed.media[1] = { ref: '/media/beta.jpg', contentId: 'sha256:cccc' };

    const before = mod.contentFingerprint(baseContent());
    const after = mod.contentFingerprint(changed);
    expect(after).not.toBe(before);
    expect(mod.snapshotId({ fingerprint: after, referenceDate: '2026-08-24' })).not.toBe(
      mod.snapshotId({ fingerprint: before, referenceDate: '2026-08-24' }),
    );
  });

  // Сценарий: закреплённый снимок в другой календарный день (единичная часть механизма).
  it('у закреплённого снимка опорная дата берётся из него, а не из календаря прогона', async () => {
    const mod = await snapshotModule();
    const pinned: Snapshot = { content: baseContent(), referenceDate: '2026-03-01', pinned: true };

    expect(mod.referenceDateOf(pinned, { calendarToday: '2026-08-24' })).toBe('2026-03-01');
    expect(mod.referenceDateOf(pinned, { calendarToday: '2027-01-15' })).toBe('2026-03-01');
  });

  it('у живого снимка опорная дата — календарь прогона в заданном поясе', async () => {
    const mod = await snapshotModule();
    const live: Snapshot = { content: baseContent(), referenceDate: '2026-08-24' };

    expect(mod.referenceDateOf(live, { calendarToday: '2026-08-24' })).toBe('2026-08-24');
    // Пояс задан явно и не наследуется от машины прогона (deploy-gating,
    // «опорная дата не зависит от машины»).
    expect(mod.REFERENCE_TIMEZONE).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
  });
});
