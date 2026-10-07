import { describe, expect, it } from 'vitest';
import { excerpt } from '../src/lib/data.js';

// Найдено сквозным тестом cms/tests/e2e: биография преподавателя в CMS необязательна, съём
// отдаёт пустую как null, и `excerpt(teacher.bio_text)` ронял сборку ВСЕГО сайта по кнопке.
describe('пустое поле CMS не роняет сборку', () => {
  it('описание страницы преподавателя без биографии — пустая строка', () => {
    expect(excerpt(null as never, 160)).toBe('');
  });
});
