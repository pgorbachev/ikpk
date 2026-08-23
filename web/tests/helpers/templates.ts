/**
 * Перечень шаблонов страниц, по которым идут браузерные проверки.
 *
 * Список объявлен ОДИН, а не по копии в каждом файле. Требование спеки change
 * `external-widgets`: перечень страниц у проверки перекрытия кнопкой чата «SHALL быть
 * ОБЩИМ с ней [проверкой доступности], а не своим: два расходящихся перечня над одним
 * предметом дают частичное покрытие с виду полным».
 *
 * Так уже было: проверка доступности шла по адресам со слэшем на конце после перехода
 * сборки на адреса без слэша, и 10 шаблонов из 14 проверяли страницу 404 при зелёном
 * прогоне и записи «36 проверок доступности» в описании PR.
 *
 * Состав СКОПИРОВАН из `a11y.spec.ts` без правки, вместе с комментариями внутри списка:
 * перенос — не повод менять покрытие.
 *
 * ── ПОЧЕМУ КОПИЯ, А НЕ ПЕРЕНОС, И ПОЧЕМУ ЭТО ВРЕМЕННО ───────────────────────
 * Сессия тестов перечень скопировала и `a11y.spec.ts` НЕ тронула. Причина внешняя и
 * названа вслух: изъятие блока из `a11y.spec.ts` сдвигает номера строк, а на них
 * ссылаются артефакты соседнего активного change (`openspec/changes/social-accounts/`),
 * и обязательный гейт `./bin/check-spec-refs` от этого краснеет — измерено, девять
 * расхождений при нуле до правки. Править чужие артефакты, чтобы починить свой гейт,
 * хуже, чем отложить перенос.
 *
 * Пока перенос не сделан, два списка существуют одновременно — то есть требование
 * «перечень общий» НЕ выполнено. Это стережёт КРАСНЫЙ тест
 * (`web/tests/external-widgets-guard.test.ts`, «перечень шаблонов общий с проверкой
 * доступности»): он требует, чтобы `a11y.spec.ts` читал этот модуль. Реализация делает
 * перенос в своём PR, где сдвиг номеров всё равно происходит от появления компонентов.
 */
export interface Template {
  name: string;
  path: string;
}

export const TEMPLATES: Template[] = [
  { name: 'home', path: '/' },
  {
    name: 'course',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/prikladnaya-kineziologiya',
  },
  {
    name: 'seminar',
    path: '/institut-klinicheskoy-prikladnoy-kineziologii/korrekciya-strukturnyh-narushenij-osteoprakticheskimi-i-myshechno-energeticheskimi-tehnikami/korrekciya-strukturnyh-narushenij-shejnogo-otdela-pozvonochnika-pleche-lopatochnogo-regiona-i-verhnih-konechnostej',
  },
  { name: 'article', path: '/statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme' },
  // варианты редизайна b/c/d и architecture-прототипы собираются только при
  // DEMO_FORMS (build:demo). Job Playwright smoke строит прод → эти пути дают
  // 404, и тест ниже их пропускает. Прототипы вне a11y-гейта CI; проверка —
  // локально на демо-сборке.
  { name: 'preview-b', path: '/preview/b' },
  { name: 'preview-c', path: '/preview/c' },
  { name: 'preview-d', path: '/preview/d' },
  // страница видео-плейлиста с фасадом (FR-04)
  { name: 'video', path: '/video/33' },
  // контакты с ленивой картой + форма подписки (card-вариант)
  { name: 'kontakty', path: '/kontakty' },
  // Внутренние страницы, которых в списке не было, а правки их касаются:
  // фильтры статей (видимый фокус), аккордеоны оплаты и «Сведений»,
  // расписание с фасетами, страница института с портретами.
  { name: 'oplata', path: '/oplata' },
  { name: 'statyi', path: '/statyi' },
  { name: 'raspisanie', path: '/raspisanie-i-tseny' },
  { name: 'svedeniya', path: '/svedeniya-ob-obrazovatelnoy-organizatsii' },
  { name: 'institute', path: '/institut-apledzhera' },
];
