import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyEditorForms } from './forms.ts';

// Форма редактора показывает ТОЛЬКО поля из своего списка (`layouts.edit`). Поле схемы, не
// попавшее ни в список, ни в явно скрытые, редактор не видит вовсе: так при сведении PR #186
// с main из формы семинара выпали учебный план, режим обучения, рекомендации и сведения о
// документах — поля есть, заполнить их нельзя.
const SCHEMAS = {
  'api::seminar.seminar': 'seminar',
  'api::schedule-entry.schedule-entry': 'schedule-entry',
} as const;

function attributesOf(name: string): string[] {
  const file = join(import.meta.dirname, '..', 'api', name, 'content-types', name, 'schema.json');
  return Object.keys(JSON.parse(readFileSync(file, 'utf-8')).attributes);
}

interface Configuration {
  metadatas: Record<string, { edit?: { visible?: boolean; editable?: boolean; label?: string; description?: string } }>;
  layouts: { edit: { name: string; size?: number }[][] };
}

async function configurations() {
  const saved = new Map<string, Configuration>();
  const strapi = {
    contentType: (uid: string) => uid,
    plugin: () => ({
      service: () => ({
        // Как у настоящего Strapi: метаданные есть у каждого поля схемы, видимы по умолчанию.
        findConfiguration: async (uid: keyof typeof SCHEMAS) => ({
          settings: {},
          metadatas: Object.fromEntries(
            attributesOf(SCHEMAS[uid]).map((field) => [field, { edit: { visible: true }, list: {} }]),
          ),
          layouts: {},
        }),
        updateConfiguration: async (uid: string, next: Configuration) => saved.set(uid, next),
      }),
    }),
  };
  await applyEditorForms(strapi);
  return saved;
}

test('каждое поле схемы семинара и проведения либо в форме редактора, либо скрыто явно', async () => {
  const saved = await configurations();
  for (const [uid, name] of Object.entries(SCHEMAS)) {
    const config = saved.get(uid);
    assert.ok(config, `форма ${uid} не настроена — проверять нечего`);
    const inForm = new Set(config.layouts.edit.flat().map((cell) => cell.name));
    const hidden = new Set(
      Object.entries(config.metadatas)
        .filter(([, meta]) => meta.edit?.visible === false)
        .map(([field]) => field),
    );
    const lost = attributesOf(name).filter((field) => !inForm.has(field) && !hidden.has(field));
    assert.deepEqual(lost, [], `${uid}: поля схемы, которых редактор не увидит`);
  }
});

test('изображение проведения редактируется, а исходный флаг коллекции остаётся скрытой метаданной', async () => {
  const config = await configurations().then((saved) => saved.get('api::schedule-entry.schedule-entry'));
  assert.ok(config, 'форма проведения не настроена — проверять нечего');
  const inForm = new Set(config.layouts.edit.flat().map((cell) => cell.name));
  const image = config.metadatas.image?.edit;
  assert.equal(image?.visible, true);
  assert.equal(image?.editable, true);
  assert.equal(image?.label, 'Изображение');
  assert.ok(inForm.has('image'), 'изображение проведения должно быть в форме редактора');

  const collectionFlag = config.metadatas.isEventCollection?.edit;
  assert.equal(collectionFlag?.visible, false);
  assert.equal(collectionFlag?.editable, false);
  assert.ok(!inForm.has('isEventCollection'), 'исходный флаг коллекции не должен добавлять новый UI');
});

test('список проведений и преподаватели проведения занимают всю строку формы', async () => {
  const saved = await configurations();
  const seminar = saved.get('api::seminar.seminar');
  const entry = saved.get('api::schedule-entry.schedule-entry');
  assert.ok(seminar && entry);
  const width = (config: Configuration, name: string) =>
    config.layouts.edit.flat().find((cell) => cell.name === name)?.size;
  assert.equal(width(seminar, 'schedule_entries'), 12, 'проведения не должны сжиматься в половину строки');
  assert.equal(width(entry, 'teachers'), 12, 'преподаватели проведения не должны сжиматься в половину строки');
  assert.equal(seminar.metadatas.schedule_entries?.edit?.label, 'Проведения');
  const seminarOrder = seminar.layouts.edit.flat().map((cell) => cell.name);
  assert.equal(
    seminarOrder[seminarOrder.indexOf('schedule_entries') - 1],
    'teachers',
    'проведения идут сразу после преподавателей',
  );
  assert.equal(seminar.metadatas.documents?.edit?.label, 'Документы');
  assert.equal(seminar.metadatas.training_registries?.edit?.label, 'Реестры обучения');
  assert.equal(seminar.metadatas.nmo?.edit?.label, 'Сведения о НМО');
});

test('подсказки говорят, где поле видно на сайте', async () => {
  const saved = await configurations();
  const seminar = saved.get('api::seminar.seminar');
  const entry = saved.get('api::schedule-entry.schedule-entry');
  assert.ok(seminar && entry);
  const hint = (config: Configuration, name: string) => config.metadatas[name]?.edit?.description ?? '';
  assert.match(hint(seminar, 'order'), /каталоге программы/);
  assert.match(hint(seminar, 'order'), /дате начала/);
  assert.match(hint(seminar, 'full_text'), /старого формата/);
  assert.match(hint(seminar, 'documents_owner_verified'), /не читает/);
  assert.match(hint(seminar, 'learning_mode'), /Как проходит обучение/);
  assert.match(hint(seminar, 'image'), /seminary/);
  assert.match(hint(seminar, 'image'), /картинка программы/);
  assert.equal(entry.metadatas.registrationFormLink?.edit?.label, 'Ссылка на регистрацию на семинар');
  assert.match(hint(entry, 'registrationFormLink'), /в расписании скрыта/);
  assert.match(hint(entry, 'registrationFormLink'), /Обязательна для публикации/);
  assert.match(hint(entry, 'startAt'), /Порядок/);
  assert.match(hint(entry, 'entry_status'), /active/);
  assert.match(hint(entry, 'oldPrice'), /не показывает/);
  assert.match(hint(entry, 'description'), /не выводится/);
  assert.match(hint(entry, 'additionalText'), /Начало в ЧЧ:ММ/);
  assert.match(hint(entry, 'isFree'), /Бесплатно/);
});

test('редактор может выбрать преподавателей конкретного проведения в форме', async () => {
  const config = await configurations().then((saved) => saved.get('api::schedule-entry.schedule-entry'));
  assert.ok(config);
  const teacher = config.metadatas.teachers?.edit;
  assert.equal(teacher?.visible, true, 'связь преподавателей должна быть видна');
  assert.equal(teacher?.editable, true, 'связь преподавателей должна быть редактируемой');
  assert.equal(teacher?.label, 'Преподаватели проведения');
  assert.ok(config.layouts.edit.flat().some((cell) => cell.name === 'teachers'));
});
