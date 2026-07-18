// Lighthouse CI: бюджеты из docs/kpi-validation.md (план 004, Этап 0).
// Медиана 5 прогонов на 4 шаблонах: главная, курс (depth=2),
// семинар (depth=3), статья. Mobile preset (дефолт Lighthouse).
// Desktop-бюджет (Perf ≥90) проверяется на staging в Этапе 5.

const TEMPLATE_URLS = [
  'http://localhost/',
  'http://localhost/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya/',
  'http://localhost/institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej/',
  'http://localhost/statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme/',
];

module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      url: TEMPLATE_URLS,
      numberOfRuns: 5,
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.85, aggregationMethod: 'median-run' }],
        'categories:seo': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500, aggregationMethod: 'median-run' }],
        'total-blocking-time': ['error', { maxNumericValue: 200, aggregationMethod: 'median-run' }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1, aggregationMethod: 'median-run' }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
