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
  metadatas: Record<string, { edit?: { visible?: boolean; editable?: boolean; label?: string } }>;
  layouts: { edit: { name: string }[][] };
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

test('редактор может выбрать преподавателей конкретного проведения в форме', async () => {
  const config = await configurations().then((saved) => saved.get('api::schedule-entry.schedule-entry'));
  assert.ok(config);
  const teacher = config.metadatas.teachers?.edit;
  assert.equal(teacher?.visible, true, 'связь преподавателей должна быть видна');
  assert.equal(teacher?.editable, true, 'связь преподавателей должна быть редактируемой');
  assert.equal(teacher?.label, 'Преподаватели проведения');
  assert.ok(config.layouts.edit.flat().some((cell) => cell.name === 'teachers'));
});
