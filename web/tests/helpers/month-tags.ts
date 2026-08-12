/**
 * Объявленные метки браузерных сценариев фильтра месяца — ОДИН список на два гейта.
 *
 * Сверок с этим списком две, и они смотрят на разное:
 *
 *   `tests/browser-test-gating.test.ts` — на СОБРАННЫЙ набор (`playwright test --list`):
 *       объявлено ↔ существует, симметрично в обе стороны;
 *   `scripts/check-month-run.ts` — на ПРОГОН (JSON-отчёт того самого запуска, который
 *       делает гейт публикации): объявленная метка обязана иметь тест, который
 *       ВЫПОЛНИЛСЯ, а не был пропущен.
 *
 * Почему список вынесен сюда, а не скопирован во второй файл: две копии разойдутся, и
 * тогда «объявлено» перестанет быть одним фактом — сверка начнёт зависеть от того, в
 * какой файл смотрели. Копию пришлось бы ещё и сверять третьей проверкой.
 *
 * Зачем нужна вторая сверка, если первая уже есть. Сбор `--list` пропуск ВО ВРЕМЯ
 * ПРОГОНА не видит: `test.skip(true, '…')` в теле теста в перечне выглядит как
 * `expectedStatus: "passed"` без аннотаций — отличить от живого нечем. Измерено на
 * голове `19fdc1a1c8657404af5ac8f0d02eb0c0d7c52f5f`: одна такая строка в
 * `@month-narrow` оставляла мета-гейт зелёным целиком (6 passed → 6 passed), а сам
 * прогон playwright давал `1 skipped` и код выхода 0. В репозитории такие формы уже
 * есть — `tests/a11y.spec.ts` (`test.fixme(true, …)` и `test.fixme(knownBroken.has(…))`),
 * то есть путь не гипотетический. Статическая форма (`test.skip` в заголовке) ловится
 * первой сверкой; рантайм-форма — только этой.
 */

export const EXPECTED_MONTH_TAGS = [
  '@month-narrow',
  '@month-city',
  '@month-search-order',
  '@month-empty-state',
  '@month-url-stable',
  '@month-cascade',
  '@month-pagination',
  '@month-pagination-return',
  '@month-supplement',
  '@month-supplement-synthetic',
  '@month-a11y-focus',
  '@month-no-layout-shift',
  '@month-mobile',
  '@month-page-reset',
  '@month-whole-key',
  '@month-three-months',
  '@month-empty-list',
  '@month-missing-control',
];

/**
 * Playwright 1.62.1 кладёт метку в `tags` БЕЗ ведущей `@` (`@month-narrow` в имени →
 * `"month-narrow"` в перечне). Проверено прогоном; сверка, сравнивающая объявление с
 * полем напрямую, была бы красной по причине, не имеющей отношения к предмету.
 */
export const normalizeTag = (tag: string): string => tag.replace(/^@/, '');
