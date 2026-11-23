import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { applyEditorForms } from './forms.ts';
import { auditMigration } from '../../scripts/audit-data-migration.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const Database = require('better-sqlite3');
const auditDirectory = mkdtempSync(join(tmpdir(), 'ikpk-article-forms-audit-'));
after(() => rmSync(auditDirectory, { recursive: true, force: true }));

// Форма редактора показывает ТОЛЬКО поля из своего списка (`layouts.edit`). Поле схемы, не
// попавшее ни в список, ни в явно скрытые, редактор не видит вовсе: так при сведении PR #186
// с main из формы семинара выпали учебный план, режим обучения, рекомендации и сведения о
// документах — поля есть, заполнить их нельзя.
const SCHEMAS = {
  'api::article.article': 'article',
  'api::seminar.seminar': 'seminar',
  'api::schedule-entry.schedule-entry': 'schedule-entry',
  'api::course-group.course-group': 'course-group',
  'api::institute.institute': 'institute',
} as const;

const OWNED_LAYOUTS = new Set([
  'api::article.article',
  'api::seminar.seminar',
  'api::schedule-entry.schedule-entry',
  'api::course-group.course-group',
]);

const ARTICLE_EXISTING_CONFIGURATION = {
  settings: { mainField: 'title', defaultSortBy: 'published_date', defaultSortOrder: 'DESC' },
  layouts: {
    edit: [
      [{ name: 'title', size: 12 }],
      [{ name: 'slug', size: 6 }],
      [{ name: 'body', size: 12 }],
      [{ name: 'image', size: 6 }],
      [{ name: 'published_date', size: 6 }],
      [{ name: 'legacy_id', size: 6 }],
      [{ name: 'seo', size: 12 }],
      [{ name: 'categories', size: 12 }],
    ],
    list: [['title', 'published_date']],
  },
};

function attributesOf(name: string): string[] {
  const file = join(import.meta.dirname, '..', 'api', name, 'content-types', name, 'schema.json');
  return Object.keys(JSON.parse(readFileSync(file, 'utf-8')).attributes);
}

interface Configuration {
  settings?: Record<string, unknown>;
  metadatas: Record<string, {
    edit?: { visible?: boolean; editable?: boolean; label?: string; description?: string; mainField?: string };
    list?: { label?: string };
  }>;
  layouts: { edit: { name: string; size?: number }[][]; [key: string]: unknown };
}

async function configurations(onInitialConfiguration?: (uid: string, configuration: unknown) => void) {
  const saved = new Map<string, Configuration>();
  const strapi = {
    contentType: (uid: string) => uid,
    plugin: () => ({
      service: () => ({
        // Как у настоящего Strapi: метаданные есть у каждого поля схемы, видимы по умолчанию.
        findConfiguration: async (uid: keyof typeof SCHEMAS) => {
          const metadatas: Configuration['metadatas'] = Object.fromEntries(
            attributesOf(SCHEMAS[uid]).map((field) => [field, { edit: { visible: true }, list: {} }]),
          );
          const configuration = {
            settings: uid === 'api::article.article' ? ARTICLE_EXISTING_CONFIGURATION.settings : {},
            metadatas,
            layouts: uid === 'api::article.article' ? ARTICLE_EXISTING_CONFIGURATION.layouts : {},
          };
          onInitialConfiguration?.(uid, structuredClone(configuration));
          return configuration;
        },
        updateConfiguration: async (uid: string, next: Configuration) => saved.set(uid, next),
      }),
    }),
  };
  await applyEditorForms(strapi);
  return saved;
}

function auditSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function auditFileFingerprint(path: string): string {
  const parts = [path, `${path}-wal`].map((file) => {
    try { return { file: file.split('/').at(-1), sha256: auditSha256(readFileSync(file)) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file !== path) {
        return { file: file.split('/').at(-1), absent: true };
      }
      throw error;
    }
  });
  return auditSha256(JSON.stringify(parts));
}

function createArticleAuditDatabase(path: string, configuration: Configuration) {
  const db = new Database(path);
  db.exec('CREATE TABLE strapi_core_store_settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL, value TEXT, type TEXT, environment TEXT, tag TEXT)');
  db.prepare('INSERT INTO strapi_core_store_settings VALUES (1, ?, ?, ?, ?, ?)')
    .run('plugin_content_manager_configuration_content_types::api::article.article', JSON.stringify(configuration), 'object', null, null);
  db.close();
}

function addArticleAuditLineage(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ikpk_migration_lineage (singleton, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_migration_operations (operation_id, lineage_id, source_snapshot_sha256, source_schema_sha256, created_at);
    CREATE TABLE ikpk_data_migration_history (lineage_id, operation_id, step_id, payload_sha256, result_json, completed_at);
  `);
  db.prepare('INSERT INTO ikpk_migration_lineage VALUES (1, ?, ?, ?, ?)').run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 1);
  db.prepare('INSERT INTO ikpk_migration_operations VALUES (?, ?, ?, ?, ?)').run('article-forms-contract', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 1);
  db.close();
}

function auditArticleConfiguration(sourcePath: string, candidatePath: string) {
  const manifestPath = join(auditDirectory, 'article-forms-plan.json');
  const manifestBytes = Buffer.from('{"version":1,"steps":[]}\n');
  writeFileSync(manifestPath, manifestBytes);
  const planSha256 = auditSha256(manifestBytes);
  const receipt = {
    sourceDbPath: sourcePath,
    candidateDbPath: candidatePath,
    operationId: 'article-forms-contract',
    planSha256,
    steps: [],
    source: {
      snapshotSha256: 'b'.repeat(64),
      schemaFingerprint: 'c'.repeat(64),
      sourceFileFingerprint: auditFileFingerprint(sourcePath),
    },
    candidatePostMigrationSha256: auditSha256(readFileSync(candidatePath)),
    candidatePostMigrationFileFingerprint: auditFileFingerprint(candidatePath),
  };
  return auditMigration({
    sourceDbPath: sourcePath,
    candidateDbPath: candidatePath,
    plan: { manifestPath, planSha256, steps: [] },
    receipt,
  });
}

test('каждое поле схемы статьи, семинара, проведения и программы либо в форме редактора, либо скрыто явно', async () => {
  const saved = await configurations();
  for (const [uid, name] of Object.entries(SCHEMAS).filter(([uid]) => OWNED_LAYOUTS.has(uid))) {
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

test('подписи и подсказки статьи синхронизируются без изменения её расположения или настроек', async () => {
  const config = await configurations().then((saved) => saved.get('api::article.article'));
  assert.ok(config, 'метаданные статьи не настроены — проверять нечего');

  assert.equal(config.metadatas.title?.edit?.label, 'Заголовок');
  assert.equal(config.metadatas.slug?.edit?.label, 'Адрес страницы');
  assert.match(config.metadatas.slug?.edit?.description ?? '', /формируется из заголовка/i);
  assert.match(config.metadatas.slug?.edit?.description ?? '', /После сохранения адрес не меняется/i);
  assert.equal(config.metadatas.slug?.edit?.editable, false);
  assert.equal(config.metadatas.body?.edit?.label, 'Текст статьи');
  assert.equal(config.metadatas.image?.edit?.label, 'Изображение');
  assert.equal(config.metadatas.published_date?.edit?.label, 'Дата публикации');
  assert.match(config.metadatas.published_date?.edit?.description ?? '', /календарный день по Москве/i);
  assert.match(config.metadatas.published_date?.edit?.description ?? '', /если очистить уже сохранённую дату, останется прежний день/i);
  assert.equal(config.metadatas.legacy_id?.edit?.label, 'Старый идентификатор');
  assert.equal(config.metadatas.seo?.edit?.label, 'SEO');
  assert.match(config.metadatas.seo?.edit?.description ?? '', /Можно не заполнять/i);
  assert.match(config.metadatas.seo?.edit?.description ?? '', /заголовок из названия статьи/i);
  assert.match(config.metadatas.seo?.edit?.description ?? '', /описание — из её текста после очистки/i);
  assert.match(config.metadatas.seo?.edit?.description ?? '', /если SEO-описание не заполнено и после очистки текста не останется, обновление сайта не состоится/i);
  assert.match(config.metadatas.seo?.edit?.description ?? '', /CMS останется опубликованной/i);
  assert.equal(config.metadatas.categories?.edit?.label, 'Категории');
  assert.equal(config.metadatas.title?.list?.label, 'Заголовок');
  assert.equal(config.metadatas.seo?.list?.label, 'SEO');

  assert.deepEqual(config.layouts, ARTICLE_EXISTING_CONFIGURATION.layouts);
  assert.deepEqual(config.settings, ARTICLE_EXISTING_CONFIGURATION.settings);
});

test('preservation audit accepts the exact article configuration written by applyEditorForms and rejects a changed SEO description', async () => {
  const initial = new Map<string, Configuration>();
  const saved = await configurations((uid, configuration) => {
    if (uid === 'api::article.article') initial.set(uid, configuration as Configuration);
  });
  const source = initial.get('api::article.article');
  const actual = saved.get('api::article.article');
  assert.ok(source && actual, 'article editor configuration must be available before and after applyEditorForms');

  const sourcePath = join(auditDirectory, 'article-forms-contract-source.db');
  const candidatePath = join(auditDirectory, 'article-forms-contract-candidate.db');
  createArticleAuditDatabase(sourcePath, source);
  createArticleAuditDatabase(candidatePath, actual);
  addArticleAuditLineage(candidatePath);

  const report = auditArticleConfiguration(sourcePath, candidatePath);
  assert.equal(report.passed, true, JSON.stringify(report.differences));

  const changedPath = join(auditDirectory, 'article-forms-contract-changed.db');
  const changed = structuredClone(actual);
  changed.metadatas.seo!.edit!.description = 'Unreviewed description';
  createArticleAuditDatabase(changedPath, changed);
  addArticleAuditLineage(changedPath);
  const rejected = auditArticleConfiguration(sourcePath, changedPath);
  assert.equal(rejected.passed, false, 'auditor must reject an SEO description outside the actual forms output');
  assert.ok(rejected.differences.some(({ table, kind }) => table === 'strapi_core_store_settings' && kind === 'core-store-structure-mismatch'));
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
  assert.match(hint(entry, 'city'), /Для публикации очного проведения укажите город/);
  assert.match(hint(entry, 'city'), /В черновике поле можно оставить пустым/);
  assert.doesNotMatch(hint(entry, 'city'), /обязателен при публикации/);
  assert.match(hint(entry, 'startAt'), /Порядок/);
  assert.match(hint(entry, 'entry_status'), /active/);
  assert.match(hint(entry, 'oldPrice'), /не показывает/);
  assert.match(hint(entry, 'description'), /не выводится/);
  assert.match(hint(entry, 'additionalText'), /Начало в ЧЧ:ММ/);
  assert.match(hint(entry, 'isFree'), /Бесплатно/);
});

test('программа называется по-русски, её адрес закрыт, а в выборе виден институт', async () => {
  const saved = await configurations();
  const program = saved.get('api::course-group.course-group');
  const seminar = saved.get('api::seminar.seminar');
  const institute = saved.get('api::institute.institute');
  assert.ok(program && seminar && institute);
  assert.equal(program.metadatas.slug?.edit?.editable, false);
  assert.equal(program.metadatas.editor_label?.edit?.visible, false);
  assert.equal(program.settings?.mainField, 'editor_label');
  assert.equal(seminar.metadatas.course_group?.edit?.mainField, 'editor_label');
  assert.equal(institute.metadatas.course_groups?.edit?.label, 'Программы');
  assert.equal(institute.metadatas.course_groups?.edit?.mainField, 'editor_label');
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
