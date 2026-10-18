import { defineConfig } from 'vitest/config';

/**
 * Провижининг в одноразовом Docker-контейнере. Набор запускается последовательно
 * отдельным шагом обязательного workflow Tests; так очистка контейнера изолирована
 * от параллельного набора и сохраняется отдельный диагностический отчёт.
 *
 * Локальный запуск из `web/`: `npx vitest run --config vitest.provision.config.ts`.
 * Нужен работающий Docker.
 * hookTimeout выше умолчания vitest (10 с), потому что уборка контейнера
 * вызывает `docker rm -f`, а сам вызов docker может ждать до 5 минут.
 */
export default defineConfig({
  test: {
    include: [
      'tests/trial-environment.test.ts',
      'tests/server-provisioning-container.test.ts',
      'tests/server-provisioning-verify.test.ts',
    ],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
