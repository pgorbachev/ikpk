import { describe, expect, it } from 'vitest';
import { redirectsFromAddressHistory } from '../scripts/lib/history-redirects';

const snapshot = (types: Record<string, Record<string, unknown>[]>) => ({
  referenceDate: '2026-08-30',
  content: { types, media: [] },
});

describe('редиректы из истории адресов снимка', () => {
  it('все прежние адреса опубликованной записи ведут прямо на текущий адрес', () => {
    const result = redirectsFromAddressHistory(
      snapshot({
        seminars: [
          { documentId: 'seminar-1', slug: 'tretij', publishedAt: '2026-08-30T08:00:00.000Z' },
        ],
        address_histories: [
          { address: '/seminary/pervyj', owner_id: 'seminar-1', owner_type: 'seminar' },
          { address: '/seminary/vtoroj', owner_id: 'seminar-1', owner_type: 'seminar' },
        ],
      }),
    );

    expect(result).toEqual([
      { old_path: '/seminary/pervyj', new_path: '/seminary/tretij', redirect_type: '301' },
      { old_path: '/seminary/vtoroj', new_path: '/seminary/tretij', redirect_type: '301' },
    ]);
  });

  it('черновик или отсутствующий владелец не создаёт редирект в никуда', () => {
    const result = redirectsFromAddressHistory(
      snapshot({
        seminars: [{ documentId: 'draft-1', slug: 'chernovik', publishedAt: null }],
        address_histories: [
          { address: '/seminary/prezhnij', owner_id: 'draft-1', owner_type: 'seminar' },
          { address: '/seminary/udalennyj', owner_id: 'deleted-1', owner_type: 'seminar' },
        ],
      }),
    );

    expect(result).toEqual([]);
  });

  it('draft и published одного documentId выбирают опубликованный адрес независимо от порядка', () => {
    const result = redirectsFromAddressHistory(
      snapshot({
        seminars: [
          { documentId: 'seminar-1', slug: 'novyj-chernovik', publishedAt: null },
          { documentId: 'seminar-1', slug: 'tekushchij', publishedAt: '2026-08-30T08:00:00.000Z' },
        ],
        address_histories: [
          { address: '/seminary/prezhnij', owner_id: 'seminar-1', owner_type: 'seminar' },
        ],
      }),
    );

    expect(result).toEqual([
      { old_path: '/seminary/prezhnij', new_path: '/seminary/tekushchij', redirect_type: '301' },
    ]);
  });

  it('переименование программы не порождает редиректы для её семинаров', () => {
    const result = redirectsFromAddressHistory(
      snapshot({
        course_groups: [
          { documentId: 'program-1', slug: 'novaya-programma', publishedAt: '2026-08-30T08:00:00.000Z' },
        ],
        seminars: [
          { documentId: 'seminar-1', slug: 'stabilnyj', publishedAt: '2026-08-30T08:00:00.000Z' },
        ],
        address_histories: [
          { address: '/programmy/staraya-programma', owner_id: 'program-1', owner_type: 'course-group' },
        ],
      }),
    );

    expect(result).toEqual([
      { old_path: '/programmy/staraya-programma', new_path: '/programmy/novaya-programma', redirect_type: '301' },
    ]);
  });
});
