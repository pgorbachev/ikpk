import { defineConfig } from 'vitest/config';

// Состав определяется РАСПОЛОЖЕНИЕМ файла, а не списком имён: в web/ разделение
// unit/build держится на двух списках, которые надо синхронизировать вручную
// (см. docs/test-audit-2026-08-07.md, находка 8). Здесь этой ошибки нет по
// построению — всё, что лежит в lib/, попадает в прогон само.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
  },
});
