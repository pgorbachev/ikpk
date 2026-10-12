import { defineConfig } from 'vitest/config';

/**
 * Провижининг в одноразовом Docker-контейнере. Набор локальный: на раннере
 * GitHub `docker rm` не успевает за лимит хука и красит обязательный прогон.
 *
 * Запуск из `web/`: `npx vitest run --config vitest.provision.config.ts`.
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
