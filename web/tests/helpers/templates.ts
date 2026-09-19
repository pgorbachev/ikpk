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
  // Шаблон семинара выше — БЕЗ дат, и это не мелочь: axe на нём не видит ни одной
  // карточки расписания, ни кнопки записи, ни ссылки на преподавателя, ни цены, то
  // есть проверяет пустую панель. Датированный шаблон добавлен отдельной строкой, а
  // не заменой: недатированных страниц 81 из 126, и терять их покрытие нельзя.
  // Что страница действительно датирована, утверждается ниже кодом, а не надеждой:
  // даты уходят от хода времени, и молча опустевший шаблон вернул бы ровно тот
  // «проверено впустую», из-за которого строка и появилась.
  { name: 'seminar-dated', path: '/institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-1' },
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
