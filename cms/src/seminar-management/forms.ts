import { SCHEDULE_ENTRY_UID, SEMINAR_UID } from './rules.js';

const PUBLISH_HINT =
  'Публикация записи сохраняет её в CMS и ещё не обновляет публичный сайт. Сайт обновляется отдельным действием «Обновить сайт».';

const SEMINAR_FIELDS = [
  ['name', 'Название', 6, true, PUBLISH_HINT],
  ['slug', 'Адрес страницы', 6, false, 'Создаётся из названия. Уже заданный адрес сам не меняется.'],
  ['course_group', 'Программа', 6, true, ''],
  ['seminar_status', 'Статус набора', 6, true, ''],
  ['duration', 'Продолжительность', 6, true, ''],
  ['price', 'Цена', 4, true, ''],
  ['order', 'Порядок', 4, true, ''],
  ['teachers', 'Преподаватели', 6, true, ''],
  ['image', 'Изображение', 6, true, ''],
  ['description', 'Краткое описание', 12, true, ''],
  ['full_text', 'Полный текст', 12, true, ''],
  ['schedule_entries', 'Проведения', 6, true, 'Дата и город видны в списке до открытия записи.'],
  ['seo', 'SEO', 12, true, ''],
];

const ENTRY_FIELDS = [
  ['seminar', 'Семинар', 6, true, ''],
  ['startAt', 'Начало', 6, true, ''],
  ['endAt', 'Окончание', 6, true, ''],
  ['city', 'Город', 6, true, ''],
  ['entry_status', 'Статус', 6, true, ''],
  ['isFree', 'Бесплатно', 4, true, ''],
  ['price', 'Цена', 4, true, ''],
  ['oldPrice', 'Прежняя цена', 4, true, ''],
  ['duration', 'Продолжительность', 6, true, ''],
  ['registrationFormLink', 'Ссылка на запись', 12, true, ''],
  ['description', 'Описание', 12, true, ''],
  ['additionalText', 'Примечание', 12, true, ''],
];

const HIDDEN = new Set(['name', 'admin_label', 'legacy_id', 'teachers']);

function labelOf(fields, name, fallback) {
  const found = fields.find((field) => field[0] === name);
  return found ? found[1] : fallback;
}

const HIDDEN_LABELS = {
  name: 'Служебное имя',
  admin_label: 'Когда и где',
  legacy_id: 'Старый идентификатор',
  teachers: 'Преподаватели проведения',
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
    ['name', 'seminar_status', 'slug'],
    new Set(['legacy_id']),
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
}
