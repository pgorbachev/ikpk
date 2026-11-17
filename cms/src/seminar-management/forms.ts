import { SCHEDULE_ENTRY_UID, SEMINAR_UID } from './rules.js';

const PUBLISH_HINT =
  'Публикация записи сохраняет её в CMS и ещё не обновляет публичный сайт. Сайт обновляется отдельным действием «Обновить сайт».';

const SEMINAR_FIELDS = [
  ['name', 'Название', 6, true, PUBLISH_HINT],
  ['slug', 'Адрес страницы', 6, false, 'Создаётся из названия. Уже заданный адрес сам не меняется.'],
  ['course_group', 'Программа', 6, true, 'Для публикации выберите опубликованную программу. Черновик можно сохранить без неё.'],
  ['order', 'Порядок', 4, true, 'Место карточки в каталоге программы и на странице «Семинары». Расписание и ближайшие семинары сортируются по дате начала, это поле их не двигает. Меньшее число раньше, пустое — в конце.'],
  ['teachers', 'Преподаватели', 6, true, 'Имя ведущего на странице семинара. Если у проведения преподаватели не выбраны, на сайте будут эти.'],
  ['schedule_entries', 'Проведения', 12, true, 'Дата и город видны в списке до открытия записи.'],
  ['duration', 'Продолжительность по умолчанию', 6, true, 'Показывается у проведения, если там своя продолжительность не задана.'],
  ['image', 'Изображение', 6, true, 'Показывается на странице семинара с коротким адресом /seminary/. Используется как запасная картинка программы, если у программы нет своей.'],
  ['description', 'Краткое описание', 12, true, 'Вступление на странице семинара и текст карточки в каталоге. Разделы ниже выводятся на страницу отдельно.'],
  ['audience', 'Для кого подойдёт', 12, true, 'Сворачиваемый раздел «Для кого подойдёт» на странице семинара.'],
  ['full_text', 'Прежний полный текст', 12, true, 'Сайт читает это поле только у семинара старого формата. У текущих семинаров текст уже разобран по разделам, и поле пустое.'],
  ['learning_plan', 'Учебный план', 12, true, 'Сворачиваемый раздел «Учебный план» на странице семинара.'],
  ['learning_mode', 'Режим обучения', 12, true, 'Сворачиваемый раздел на странице семинара. Заголовок там — «Как проходит обучение».'],
  ['recommendations', 'Рекомендации', 12, true, 'Сворачиваемый раздел «Рекомендации» на странице семинара.'],
  ['documents_state', 'Выдаваемые документы', 6, true, 'unconfirmed скрывает блок на сайте. not-issued показывает «Выдача документов не предусмотрена». issued показывает документы, реестры и НМО, если они заполнены.'],
  ['documents', 'Документы', 12, true, 'Попадают в блок «Выдаваемые документы», когда состояние — issued.'],
  ['training_registries', 'Реестры обучения', 12, true, 'Строки про реестр обучения в том же блоке, когда состояние — issued.'],
  ['nmo', 'Сведения о НМО', 12, true, 'Фраза про баллы НМО в том же блоке. На сайте видны только статусы possible и awarded.'],
  ['documents_owner_verified', 'Актуальность подтверждена владельцем', 6, true, 'Сайт это поле не читает, и для публикации оно не нужно. Сейчас оно пустое у всех семинаров.'],
  ['documents_confirmation_date', 'Дата подтверждения сведений', 6, true, 'На сайт не выводится. Вместе с основанием и автором нужна, чтобы подтвердить сведения о документах.'],
  ['documents_confirmation_author', 'Кто подтвердил', 6, true, 'На сайт не выводится. Вместе с датой и основанием нужен, чтобы подтвердить сведения о документах.'],
  ['documents_confirmation_source', 'Основание подтверждения', 12, true, 'На сайт не выводится. Вместе с датой и автором нужно, чтобы подтвердить сведения о документах.'],
  ['seo', 'SEO', 12, true, 'Можно не заполнять: сайт сам соберёт заголовок и описание из названия семинара, программы и института.'],
];

const ENTRY_FIELDS = [
  ['seminar', 'Семинар', 6, true, 'Проведение попадает на страницу этого семинара и в общее расписание.'],
  ['teachers', 'Преподаватели проведения', 12, true, 'Только для этого проведения. Если никого не выбрать, на сайте будут преподаватели семинара.'],
  ['startAt', 'Начало', 6, true, 'Расписание и ближайшие семинары сортируются по этой дате, а не по полю «Порядок» у семинара. Прошедшая дата с сайта уходит, даже если статус остаётся active.'],
  ['endAt', 'Окончание', 6, true, 'Вместе с началом задаёт срок. Списки сортируются по дате начала.'],
  ['image', 'Изображение', 6, true, 'Фото карточки в расписании. Если пусто, карточка без фото.'],
  ['isOnline', 'Онлайн', 6, true, 'На сайте город заменяется на «Онлайн», а кнопка записи становится «Записаться на вебинар».'],
  ['city', 'Город', 6, true, 'Город очного проведения на сайте. Для публикации не требуется. У онлайн-проведения поле очищается, на сайте будет «Онлайн».'],
  ['entry_status', 'Статус', 6, true, 'На сайте остаются только active. cancelled и completed пропадают из расписания и со страницы семинара.'],
  ['isFree', 'Бесплатно', 4, true, 'На сайте вместо цены будет «Бесплатно». Ноль в цене этого не делает.'],
  ['price', 'Цена', 4, true, 'Пустая цена у платного проведения на сайте — «Цена уточняется». Ноль при статусе «платно» сохранить нельзя: укажите цену или оставьте поле пустым.'],
  ['oldPrice', 'Прежняя цена', 4, true, 'Сайт прежнюю цену не показывает. Ноль не рисует зачёркнутую цену. Сейчас у проведений здесь только ноль или пусто.'],
  ['duration', 'Продолжительность', 6, true, 'Оставьте пустым, чтобы использовать продолжительность семинара.'],
  ['registrationFormLink', 'Ссылка на регистрацию на семинар', 12, true, 'Адрес кнопки «Записаться» в расписании и на странице семинара. Обязательна для публикации. Без ссылки кнопка в расписании скрыта, а на странице семинара ведёт в расписание.'],
  ['description', 'Описание', 12, true, 'На сайт не выводится. Текст для посетителя пишите в «Примечание».'],
  ['additionalText', 'Примечание', 12, true, 'Текст на карточке расписания. Фраза «Начало в ЧЧ:ММ» показывается как время начала.'],
];

const ARTICLE_FIELD_LABELS = [
  ['title', 'Заголовок', 'Заголовок статьи.'],
  ['slug', 'Адрес страницы', 'Часть адреса статьи после /statyi/.'],
  ['body', 'Текст статьи', 'Основной текст статьи на странице.'],
  ['image', 'Изображение', 'Показывается в шапке статьи и карточках каталога.'],
  ['published_date', 'Дата публикации', 'Показывается на странице статьи и задаёт порядок в каталоге: сначала новые.'],
  ['legacy_id', 'Старый идентификатор', ''],
  ['seo', 'SEO', 'Можно не заполнять: сайт возьмёт заголовок из названия статьи, а описание — из её текста после очистки. Если SEO-описание не заполнено и после очистки текста не останется, обновление сайта не состоится; запись в CMS останется опубликованной.'],
  ['categories', 'Категории', ''],
];

// The approved migration carries this source flag as data without adding editor UI.
const HIDDEN = new Set(['name', 'admin_label', 'legacy_id', 'isEventCollection']);

function labelOf(fields, name, fallback) {
  const found = fields.find((field) => field[0] === name);
  return found ? found[1] : fallback;
}

const HIDDEN_LABELS = {
  name: 'Служебное имя',
  admin_label: 'Когда и где',
  legacy_id: 'Старый идентификатор',
  teachers: 'Преподаватели проведения',
  isEventCollection: 'Исходный флаг коллекции',
};

function overlay(configuration, fields, settings, list, hidden) {
  const metadatas = { ...configuration.metadatas };
  for (const [name, label, , editable, description] of fields) {
    const current = metadatas[name] ?? { edit: {}, list: {} };
    metadatas[name] = {
      ...current,
      edit: {
        ...current.edit,
        label,
        description,
        visible: true,
        editable,
      },
      list: {
        ...current.list,
        label,
      },
    };
  }
  if (metadatas.schedule_entries?.edit) {
    metadatas.schedule_entries = {
      ...metadatas.schedule_entries,
      edit: { ...metadatas.schedule_entries.edit, mainField: 'admin_label' },
    };
  }
  for (const name of hidden) {
    if (!metadatas[name]) continue;
    const label = HIDDEN_LABELS[name] ?? labelOf(fields, name, name);
    metadatas[name] = {
      ...metadatas[name],
      edit: {
        ...metadatas[name].edit,
        label,
        visible: false,
        editable: false,
      },
      list: {
        ...metadatas[name].list,
        label,
      },
    };
  }
  const visible = fields.filter((field) => !hidden.has(field[0]));
  return {
    settings: { ...configuration.settings, ...settings },
    metadatas,
    layouts: {
      ...configuration.layouts,
      list,
      edit: visible.map(([name, , size]) => [{ name, size }]),
    },
  };
}

async function applyOne(strapi, uid, fields, settings, list, hidden) {
  const contentTypes = strapi.plugin('content-manager').service('content-types');
  const contentType = strapi.contentType(uid);
  const current = await contentTypes.findConfiguration(contentType);
  const next = overlay(current, fields, settings, list, hidden);
  await contentTypes.updateConfiguration(contentType, next);
}

async function applyArticleFieldLabels(strapi) {
  const contentTypes = strapi.plugin('content-manager').service('content-types');
  const contentType = strapi.contentType('api::article.article');
  const current = await contentTypes.findConfiguration(contentType);
  const metadatas = { ...current.metadatas };

  for (const [name, label, description] of ARTICLE_FIELD_LABELS) {
    const existing = metadatas[name] ?? { edit: {}, list: {} };
    metadatas[name] = {
      ...existing,
      edit: { ...existing.edit, label, ...(description ? { description } : {}) },
      list: { ...existing.list, label },
    };
  }

  // Синхронизация подписей не должна менять сохранённый порядок, настройки
  // или видимость/редактируемость полей статьи.
  await contentTypes.updateConfiguration(contentType, { ...current, metadatas });
}

export async function applyEditorForms(strapi) {
  await applyOne(
    strapi,
    SEMINAR_UID,
    SEMINAR_FIELDS,
    {
      mainField: 'name',
      defaultSortBy: 'name',
      defaultSortOrder: 'ASC',
    },
    ['name', 'slug'],
    new Set(['legacy_id', 'content_format', 'content_section_anchors']),
  );
  await applyOne(
    strapi,
    SCHEDULE_ENTRY_UID,
    ENTRY_FIELDS,
    {
      mainField: 'admin_label',
      defaultSortBy: 'startAt',
      defaultSortOrder: 'ASC',
    },
    ['admin_label', 'city', 'entry_status', 'startAt'],
    HIDDEN,
  );
  await applyArticleFieldLabels(strapi);
}
