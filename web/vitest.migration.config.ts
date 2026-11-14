import { getViteConfig } from 'astro/config';
export default await getViteConfig({ test: {
  include: ['tests/seminar-real-migration.migration.test.ts', 'tests/seminar-separate-fields.migration.test.ts'],
  testTimeout: 120000,
} })({ command: 'serve', mode: 'test' });
