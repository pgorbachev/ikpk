import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * ЯВНЫЙ предел теста. Без него действует умолчание vitest — 5000 мс, и это не величина
     * по существу, а ложное красное: самая долгая проверка этого набора измерена в 5802 мс
     * (`rich-content contract: whole-document hazard scan` — разбор dist браузером) на
     * незагруженной машине, то есть умолчание она перерастает сама по себе, а в обязательном
     * прогоне борется за машину с остальными файлами набора.
     *
     * Значение выбрано от ИЗМЕРЕНИЯ, а не на глаз: 5802 мс × запас на состязание за
     * процессор ≈ 15 с, и 15 с — рекомендованный верхний предел (решение владельца
     * 2026-08-19). Больше брать нельзя: предел, поднятый «с запасом на всё», превращает
     * зависшую проверку в долгую.
     *
     * Предел НЕ является исходом: ни одна проверка этого набора не выводит отказ из того, что
     * что-то не уложилось во время. Незавершившийся процесс — предмет обвязки
     * `tests/helpers/payment-service.ts`, и там он отдельный исход (`timeout`), который
     * поднимает исключение, а не читается как подтверждённый fail-closed.
     */
    testTimeout: 15_000,
    include: [
      'tests/article-catalog.test.ts',
      'tests/perf-a11y.test.ts',
      'tests/parity-compare.test.ts',
      'tests/media-migration.test.ts',
      'tests/content-quality.test.ts',
      'tests/seo-package.test.ts',
      'tests/payment-characterization.test.ts',
      'tests/payment-form-dist.test.ts',
      'tests/payment-role-dist.test.ts',
      'tests/site-copy.test.ts',
      'tests/schedule-month-dist.test.ts',
      'tests/rich-content-canary.build.test.ts',
      'tests/rich-content-hazard.build.test.ts',
      'tests/rich-content-migration.build.test.ts',
      'tests/external-widgets-dist.test.ts',
      'tests/external-widgets-config-probe.test.ts',
    ],
  },
});
