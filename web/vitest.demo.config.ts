import { defineConfig } from 'vitest/config';

/**
 * Проверки по выводу ДЕМО-сборки (`dist-demo`) — отдельный набор, потому что у них
 * отдельный предмет.
 *
 * Своя конфигурация здесь не косметика: `vitest.build.config.ts` выбирает проверки,
 * которые читают боевой `dist`, и запускать их по демо-выводу нельзя — «счётчики
 * присутствуют» прошло бы мимо предмета. Развод предметов требует change
 * `deploy-gated-on-tests` (решение 6).
 *
 * Конфигурация выбирает ФАЙЛЫ и не переопределяет корень вывода: корень объявлен в
 * `tests/helpers/demo-dist.ts`. Нацелить существующие боевые гейты на демо-каталог
 * одной конфигурацией нельзя — они читают `dist`, объявленный в их собственном
 * модуле.
 */
export default defineConfig({
  test: {
    include: ['tests/demo-output.test.ts', 'tests/demo-prototypes.test.ts', 'tests/demo-payment-form.test.ts'],
  },
});
