// Тесты по утверждённой спеке change `cms-live-snapshot-capture`
// (`openspec/changes/cms-live-snapshot-capture/specs/cms-content-source/spec.md`).
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: живого захвата нет вовсе — `web/scripts/capture-content-snapshot.ts:40`,
// `copyPinned();` вызывается безусловно. Соответствия полей как данных нет, отметки
// происхождения нет.
//
// Три требования, восемь сценариев. Соответствие «сценарий → тест» — в отчёте сессии.

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SNAPSHOT_ORIGIN_FIELD,
  STUB_DEFAULT_PAGE_SIZE,
  type CmsSchema,
  type CmsStub,
  type FieldMapEntry,
  type RequiredFieldGroup,
  type StubCollection,
  closedPortUrl,
  contractModule,
  fieldMapModule,
  pinnedSnapshot,
  readSchema,
  runCapture,
  startCmsStub,
} from './helpers/cms-live-snapshot-capture-contract';

// ─────────────────────────────────────────────────────── данные заглушки

const media = (n: number): Record<string, unknown> => ({
  id: n,
  documentId: `media-${n}`,
  name: `img-${n}.webp`,
  url: `/uploads/img-${n}.webp`,
  ext: '.webp',
  mime: 'image/webp',
  hash: `img_${n}`,
});

const seo = (name: string): Record<string, unknown> => ({
  id: 1,
  seo_title: `${name} — заголовок страницы`,
  seo_description: `${name} — описание страницы`,
  og_image: null,
  noindex: false,
});

/**
 * Ключ записи: `slug` и `legacy_id` НАМЕРЕННО совпадают. Спека не предписывает, по какому из
 * них соответствие свяжет записи, и тест не вправе это предписывать: при совпадении значений
 * связь разрешается при любом законном выборе, и проверка остаётся про потерю записей, а не
 * про вкус реализации.
 */
const key = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(3, '0')}`;

const ref = (prefix: string, n: number, name: string): Record<string, unknown> => ({
  id: n,
  documentId: `${prefix}-doc-${n}`,
  name,
  slug: key(prefix, n),
  legacy_id: key(prefix, n),
});

const base = (prefix: string, n: number, name: string): Record<string, unknown> => ({
  id: n,
  documentId: `${prefix}-doc-${n}`,
  name,
  slug: key(prefix, n),
  legacy_id: key(prefix, n),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  publishedAt: '2026-02-01T00:00:00.000Z',
});

const ARTICLE_COUNT = 130;

function article(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const title = `Статья ${n}`;
  return {
    ...base('art', n, title),
    title,
    body: `<p>Тело статьи ${n}</p>`,
    image: media(n),
    published_date: '2026-01-15T00:00:00.000Z',
    seo: seo(title),
    ...over,
  };
}

function dataset(over: Record<string, StubCollection> = {}): Record<string, StubCollection> {
  const institutes = Array.from({ length: 2 }, (_, i) =>
    ({ ...base('inst', i + 1, `Институт ${i + 1}`), shortName: `И${i + 1}`, description: '<p>Об институте</p>', image: media(i + 1), order: i, seo: seo(`Институт ${i + 1}`) }));
  const courseGroups = Array.from({ length: 3 }, (_, i) =>
    ({ ...base('cg', i + 1, `Программа ${i + 1}`), description: '<p>О программе</p>', image: media(i + 1), institute: ref('inst', 1, 'Институт 1'), seo: seo(`Программа ${i + 1}`) }));
  const teachers = Array.from({ length: 5 }, (_, i) =>
    ({ ...base('teach', i + 1, `Преподаватель ${i + 1}`), photo: media(i + 1), bio: '<p>Биография</p>', institute: ref('inst', 1, 'Институт 1') }));
  const seminars = Array.from({ length: 4 }, (_, i) =>
    ({ ...base('sem', i + 1, `Семинар ${i + 1}`), description: '<p>О семинаре</p>', full_text: '<p>Подробно</p>', image: media(i + 1), price: 1000 + i, duration: '2 дня', status: 'active', course_group: ref('cg', 1, 'Программа 1'), institute: ref('inst', 1, 'Институт 1'), teachers: [ref('teach', 1, 'Преподаватель 1')], seo: seo(`Семинар ${i + 1}`) }));
  const scheduleEntries = Array.from({ length: 3 }, (_, i) => ({
    ...base('ev', i + 1, `Событие ${i + 1}`),
    startAt: `2026-09-0${i + 1}T00:00:00.000Z`,
    endAt: `2026-09-0${i + 2}T00:00:00.000Z`,
    city: 'Санкт-Петербург',
    price: 5000,
    oldPrice: 6000,
    isFree: false,
    status: 'active',
    registrationFormLink: 'https://example.invalid/form',
    description: '<p>Описание события</p>',
    additionalText: '<p>Дополнение</p>',
    duration: '2 дня',
    seminar: ref('sem', 1, 'Семинар 1'),
    teachers: [{ id: 1, fullName: 'Преподаватель 1' }],
  }));

  return {
    institutes: { records: institutes },
    'course-groups': { records: courseGroups },
    seminars: { records: seminars },
    teachers: { records: teachers },
    articles: { records: Array.from({ length: ARTICLE_COUNT }, (_, i) => article(i + 1)) },
    'schedule-entries': { records: scheduleEntries },
    'news-items': { records: Array.from({ length: 2 }, (_, i) => ({ ...base('news', i + 1, `Новость ${i + 1}`), description: '<p>Новость</p>', image: media(i + 1), link: 'https://example.invalid', priority: i })) },
    promotions: { records: Array.from({ length: 2 }, (_, i) => ({ ...base('promo', i + 1, `Акция ${i + 1}`), description: '<p>Акция</p>', image: media(i + 1), link: 'https://example.invalid', priority: i, active: true })) },
    pages: { records: Array.from({ length: 2 }, (_, i) => ({ ...base('page', i + 1, `Страница ${i + 1}`), title: `Страница ${i + 1}`, body: '<p>Тело страницы</p>', seo: seo(`Страница ${i + 1}`) })) },
    'video-playlists': { records: Array.from({ length: 2 }, (_, i) => ({ ...base('vp', i + 1, `Плейлист ${i + 1}`), videos: [{ url: 'https://example.invalid/v' }], seo: seo(`Плейлист ${i + 1}`) })) },
    ...over,
  };
}

/**
 * Ожидаемая мощность по типам. Имена в снимке и в REST различаются (`course-groups` против
 * `course_groups`, `pages` против `static_pages`), поэтому тип узнаётся по образцу имени, а
 * не по точному совпадению: выбор имён в снимке — не предмет этой спеки.
 */
const EXPECTED_TYPES: { label: string; match: RegExp; count: number }[] = [
  { label: 'institutes', match: /institutes?/i, count: 2 },
  { label: 'course-groups', match: /course[-_ ]?groups?|programs?/i, count: 3 },
  { label: 'seminars', match: /seminars?/i, count: 4 },
  { label: 'teachers', match: /teachers?/i, count: 5 },
  { label: 'articles', match: /articles?/i, count: ARTICLE_COUNT },
  { label: 'schedule-entries', match: /schedule[-_ ]?entries|schedule/i, count: 3 },
  { label: 'news-items', match: /news([-_ ]?items)?/i, count: 2 },
  { label: 'promotions', match: /promotions?|promos?/i, count: 2 },
  { label: 'pages', match: /(static[-_ ]?)?pages?/i, count: 2 },
  { label: 'video-playlists', match: /video[-_ ]?playlists?/i, count: 2 },
];

// ─────────────────────────────────────────────────────── оснастка прогонов

let stubs: CmsStub[] = [];
const outDir = (): string => mkdtempSync(join(tmpdir(), 'lsc-snapshot-'));

async function stub(over: Record<string, StubCollection> = {}): Promise<CmsStub> {
  const started = await startCmsStub(dataset(over));
  stubs.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(stubs.map((s) => s.close().catch(() => undefined)));
  stubs = [];
});

const readSnapshot = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf-8')) as Record<string, unknown>;

const typesOf = (snap: Record<string, unknown>): Record<string, Record<string, unknown>[]> =>
  (snap.content as { types: Record<string, Record<string, unknown>[]> }).types;

// ═════════════════════════ Требование 1: чтение из живой системы управления ═════════════════

describe('снимок читается из живой системы управления, когда её адрес задан', () => {
  // Сценарий: адрес задан, система управления отвечает
  it('снимок собран из ответа системы управления, а не из фикстуры', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `захват не прошёл:\n${run.output}`).toBe(0);
    expect(existsSync(join(dir, 'snapshot.json')), 'снимок не записан').toBe(true);

    const snap = readSnapshot(dir);
    expect(snap.fingerprint, 'снимок совпал с фикстурой — значит взят из неё').not.toBe(
      pinnedSnapshot().fingerprint,
    );

    // Записи заглушки узнаваемы: их значения в фикстуре не встречаются.
    const flat = JSON.stringify(snap);
    expect(flat, 'в снимке нет записей заглушки').toContain('Статья 1');
    expect(flat, 'в снимке остались записи фикстуры').not.toContain(
      '90percent-narushenij-v-skeletno-myshechnoj-sisteme',
    );
  });

  it('вывод называет выполненный путь: живой захват, а не фикстура', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.output, 'вывод не называет адрес, с которого снято').toContain(cms.url);
    // Отрицательная половина: живой прогон не вправе сообщать, что взял фикстуру. Образец узкий
    // — «использована фикстура», «→ фикстура», — чтобы не запрещать законное упоминание вроде
    // «фикстура не использовалась».
    expect(run.output.toLowerCase(), 'живой прогон сообщает, что взял фикстуру').not.toMatch(
      /использ\w*\s+(закреплённ\w+\s+)?фикстур|→\s*фикстур|из фикстуры/,
    );
  });

  it('вывод называет число записей по каждому типу', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    for (const { label, match, count } of EXPECTED_TYPES) {
      const line = run.output
        .split('\n')
        .find((l) => match.test(l) && new RegExp(`\\b${count}\\b`).test(l));
      expect(line, `вывод не называет ${label} с числом записей ${count}`).toBeDefined();
    }
  });

  // Постраничный обход (tasks.md 3.1). Заглушка не отдаёт больше 100 записей за запрос, поэтому
  // «попросить всё одной страницей» невозможно: либо обход, либо потеря записей.
  it('постраничный обход не теряет записи за первой страницей', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);

    const types = typesOf(readSnapshot(dir));
    const articles = Object.entries(types).find(([name]) => /articles?/i.test(name))?.[1] ?? [];
    expect(articles.length, `потеряны записи за первой страницей (умолчание ${STUB_DEFAULT_PAGE_SIZE})`).toBe(
      ARTICLE_COUNT,
    );

    const flat = JSON.stringify(articles);
    for (const n of [1, STUB_DEFAULT_PAGE_SIZE + 1, ARTICLE_COUNT]) {
      expect(flat, `нет статьи №${n}`).toContain(`Статья ${n}`);
    }

    const articleRequests = cms.requests.filter((r) => r.endpoint === 'articles');
    expect(articleRequests.length, 'обход шёл одним запросом — постраничности нет').toBeGreaterThan(1);
  });

  it('мощность каждого типа в снимке равна мощности в источнике', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);

    const types = typesOf(readSnapshot(dir));
    for (const { label, match, count } of EXPECTED_TYPES) {
      const found = Object.entries(types).find(([name]) => match.test(name));
      expect(found, `в снимке нет типа ${label}`).toBeDefined();
      expect(found?.[1].length, `${label}: записей в снимке ${found?.[1].length}, в источнике ${count}`).toBe(count);
    }
  });

  // Сценарий: адрес задан, система управления недоступна
  it('недоступная система управления — отказ, фикстура не подставляется', async () => {
    const dir = outDir();
    const dead = await closedPortUrl();

    const run = await runCapture({ CMS_URL: dead, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `захват завершился успехом при недоступной системе управления:\n${run.output}`).not.toBe(0);
    expect(existsSync(join(dir, 'snapshot.json')), 'файл снимка записан вопреки отказу').toBe(false);
    expect(readdirSync(dir), 'в каталог снимка что-то подставлено').toEqual([]);
    expect(run.output, 'причина отказа не названа').toContain(dead);
  });

  it('сбой одного запроса — тот же отказ, а не снимок без одного типа', async () => {
    const cms = await stub({ seminars: { records: [], status: 500 } });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `частичный ответ принят за успех:\n${run.output}`).not.toBe(0);
    expect(existsSync(join(dir, 'snapshot.json')), 'записан частичный снимок').toBe(false);
    expect(run.output, 'отказ не называет тип, на котором сорвалось').toMatch(/seminars/i);
  });

  // Снимок не появляется на диске, пока не прошёл контракт (tasks.md 3.3). Контракт — тот же,
  // что у фикстуры (design.md, решение 2): второго, более слабого, у живого пути нет.
  it('снимок, не прошедший контракт, на диск не попадает', async () => {
    const broken = dataset().articles.records.map((r, i) => (i === 0 ? { ...r, title: '' } : r));
    const cms = await stub({ articles: { records: broken } });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `нарушение контракта не остановило захват:\n${run.output}`).not.toBe(0);
    expect(existsSync(join(dir, 'snapshot.json')), 'снимок с нарушением контракта записан').toBe(false);
    expect(run.output, 'нарушение не названо записью').toContain('art-001');
  });

  // Сценарий: адрес не задан
  it('без адреса берётся закреплённая фикстура и это названо в выводе', async () => {
    const dir = outDir();

    const run = await runCapture({ CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, run.output).toBe(0);
    expect(readSnapshot(dir).fingerprint, 'снимок не совпал с фикстурой').toBe(pinnedSnapshot().fingerprint);
    expect(run.output.toLowerCase(), 'вывод не называет взятый путь').toMatch(/фикстур|закреплённ/);
  });
});

// ═══════════════════ Требование 2: соответствие полей объявлено данными ═════════════════════

describe('соответствие полей объявлено данными, а не совпадением имён', () => {
  const schemasOf = async (): Promise<{ schemas: Record<string, CmsSchema>; components: Record<string, CmsSchema> }> => {
    const mod = await fieldMapModule();
    const schemas = Object.fromEntries(mod.SOURCE_TYPES.map((s) => [s.type, readSchema(s.schema)]));
    return { schemas, components: { 'shared.seo': readSchema('cms/src/components/shared/seo.json') } };
  };

  // Сценарий: соответствие покрывает обязательные поля снимка
  it('у каждого обязательного по контракту поля назван источник', async () => {
    const map = await fieldMapModule();
    const contract = await contractModule();

    const result = map.checkFieldMapCompleteness({
      map: map.FIELD_MAP,
      required: contract.REQUIRED_SNAPSHOT_FIELDS,
    });

    expect(result.missing, 'обязательные поля без источника').toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('соответствие, не покрывшее ни одного поля, — непройденная проверка, а не успех', async () => {
    const map = await fieldMapModule();
    const contract = await contractModule();

    const empty = map.checkFieldMapCompleteness({ map: [], required: contract.REQUIRED_SNAPSHOT_FIELDS });
    expect(empty.vacuous, 'пустое соответствие не признано вакуумным').toBe(true);
    expect(empty.ok, 'пустое соответствие прошло проверку').toBe(false);

    // И обратная сторона: пустой список обязательных полей — тоже нечего проверять.
    const nothingRequired = map.checkFieldMapCompleteness({ map: map.FIELD_MAP, required: [] });
    expect(nothingRequired.vacuous, 'пустой список обязательных полей признан проверкой').toBe(true);
    expect(nothingRequired.ok).toBe(false);
  });

  // Список обязательных полей не должен разойтись с самим контрактом: иначе полнота меряется
  // относительно списка, который реализация пишет сама (AGENTS.md, «гейты, которые ничего не
  // измеряют»). Сверка — мутацией настоящих записей фикстуры.
  it('список обязательных полей совпадает с тем, что проверяет контракт', async () => {
    const contract = await contractModule();
    const groups = contract.REQUIRED_SNAPSHOT_FIELDS;
    expect(
      Array.isArray(groups),
      'контракт снимка не экспортирует перечислимый список обязательных полей (REQUIRED_SNAPSHOT_FIELDS) — полноту соответствия мерить не по чему',
    ).toBe(true);
    expect(groups.length, 'список обязательных полей пуст — проверять нечего').toBeGreaterThan(0);

    const pinned = pinnedSnapshot();
    const types = (pinned.content as { types: Record<string, Record<string, unknown>[]> }).types;

    for (const group of groups as RequiredFieldGroup[]) {
      const records = types[group.type];
      expect(records?.length, `в фикстуре нет записей типа ${group.type}`).toBeGreaterThan(0);

      const mutated = JSON.parse(JSON.stringify(pinned)) as typeof pinned;
      const target = (mutated.content as { types: Record<string, Record<string, unknown>[]> }).types[group.type][0]!;
      for (const name of group.anyOf) target[name] = '';

      const violations = contract.validateSnapshotContract(mutated as never).violations;
      expect(
        violations.some((v) => v.type === group.type && v.rule === 'required-field-empty'),
        `${group.type}.${group.anyOf.join('|')} объявлено обязательным, но контракт его не проверяет`,
      ).toBe(true);
    }
  });

  // Сценарий: источник исчез из схемы
  it('исчезнувший источник — отказ с названием поля снимка и ожидавшегося источника', async () => {
    const map = await fieldMapModule();
    const { schemas, components } = await schemasOf();

    expect(map.checkFieldMapAgainstSchema({ map: map.FIELD_MAP, schemas, components }).ok, 'опора не зелёная: сверка со схемами не проходит и на неизменённых схемах').toBe(true);

    // Мутация: убираем из схемы атрибут, объявленный источником верхнего уровня.
    const victim = (map.FIELD_MAP as FieldMapEntry[]).find((entry) => {
      const root = entry.source.split('.')[0]!;
      return schemas[entry.type] !== undefined && schemas[entry.type]!.attributes[root] !== undefined;
    });
    expect(victim, 'ни одно соответствие не указывает на атрибут схемы — сверять нечего').toBeDefined();

    const damaged = JSON.parse(JSON.stringify(schemas)) as Record<string, CmsSchema>;
    delete damaged[victim!.type]!.attributes[victim!.source.split('.')[0]!];

    const result = map.checkFieldMapAgainstSchema({ map: map.FIELD_MAP, schemas: damaged, components });
    expect(result.ok, 'исчезнувший источник принят молча').toBe(false);
    expect(result.missingSources).toContainEqual(
      expect.objectContaining({ type: victim!.type, field: victim!.field, source: victim!.source }),
    );
  });

  it('живой захват при исчезнувшем источнике отказывает, а не отдаёт пустое поле', async () => {
    // Источник объявлен, а запись его не несёт: в ответе системы управления поля `title` нет.
    const withoutSource = dataset().articles.records.map((r) => {
      const copy = { ...r };
      delete copy.title;
      return copy;
    });
    const cms = await stub({ articles: { records: withoutSource } });
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    expect(run.status, `пропавший источник дал успешный захват:\n${run.output}`).not.toBe(0);
    expect(existsSync(join(dir, 'snapshot.json')), 'записан снимок с пустым полем').toBe(false);
    expect(run.output, 'отказ не называет исчезнувший источник').toMatch(/title/);
  });

  // Сценарий: поле схемы не участвует в соответствии
  it('незаявленное поле схемы названо в выводе и успеха не отменяет', async () => {
    const map = await fieldMapModule();
    const { schemas, components } = await schemasOf();

    const result = map.checkFieldMapAgainstSchema({ map: map.FIELD_MAP, schemas, components });

    expect(result.ok, 'незаявленное поле превращено в отказ').toBe(true);
    expect(
      result.unmapped.length,
      'ни одного незаявленного поля: проверка вакуумна — либо соответствие покрывает все атрибуты схем, и тогда это надо утверждать явно',
    ).toBeGreaterThan(0);
  });

  it('живой захват называет незаявленные поля схемы в выводе', async () => {
    const map = await fieldMapModule();
    const { schemas, components } = await schemasOf();
    const unmapped = map.checkFieldMapAgainstSchema({ map: map.FIELD_MAP, schemas, components }).unmapped;
    expect(unmapped.length, 'называть нечего — проверка вакуумна').toBeGreaterThan(0);

    const cms = await stub();
    const dir = outDir();
    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });

    for (const field of unmapped) {
      expect(run.output, `вывод не называет незаявленное поле ${field.type}.${field.field}`).toContain(field.field);
    }
    expect(run.status, 'незаявленное поле остановило захват').toBe(0);
  });
});

// ═══════════════════════ Требование 3: снимок несёт происхождение ═══════════════════════════

describe('снимок несёт происхождение', () => {
  // Сценарий: живой снимок помечен живым
  it('живой снимок несёт отметку живого происхождения, адрес и время', async () => {
    const cms = await stub();
    const dir = outDir();
    const before = Date.now();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);
    const after = Date.now();

    const origin = readSnapshot(dir)[SNAPSHOT_ORIGIN_FIELD] as { kind?: string; url?: string; capturedAt?: string } | undefined;
    expect(origin, `в снимке нет отметки происхождения (${SNAPSHOT_ORIGIN_FIELD})`).toBeDefined();
    expect(origin?.kind).toBe('live');
    expect(origin?.url, 'отметка не несёт адрес').toBe(cms.url);

    const capturedAt = Date.parse(String(origin?.capturedAt));
    expect(Number.isNaN(capturedAt), `время снятия не разбирается: ${origin?.capturedAt}`).toBe(false);
    // Секунда допуска на округление до целых секунд в ISO-строке.
    expect(capturedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(capturedAt).toBeLessThanOrEqual(after + 1000);
  });

  // Сценарий: фикстура помечена закреплённой
  it('снимок из фикстуры несёт отметку закреплённого происхождения', async () => {
    const dir = outDir();

    const run = await runCapture({ CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);

    const origin = readSnapshot(dir)[SNAPSHOT_ORIGIN_FIELD] as { kind?: string; url?: string } | undefined;
    expect(origin, `в снимке нет отметки происхождения (${SNAPSHOT_ORIGIN_FIELD})`).toBeDefined();
    expect(origin?.kind).toBe('pinned');
    expect(origin?.url, 'у закреплённого снимка нет адреса, с которого он снят').toBeUndefined();
  });

  // Происхождение отличается от отпечатка (design.md, решение 3) — и от ЧИСЕЛ журнала, которые
  // уже лежат в поле `provenance` и читаются гейтом публикации
  // (`web/scripts/publication-cli.ts:107`, `observedEntry: snap.provenance?.observedEntry`).
  it('отметка происхождения не занимает поле чисел журнала', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);

    const snap = readSnapshot(dir);
    expect(SNAPSHOT_ORIGIN_FIELD, 'происхождение положено в поле чисел журнала').not.toBe('provenance');
    const numbers = snap.provenance as Record<string, unknown> | undefined;
    if (numbers !== undefined) {
      expect(typeof numbers.observedEntry, 'гейт публикации читает отсюда число').toBe('number');
      expect(typeof numbers.highWaterMark).toBe('number');
    }
  });

  it('отпечаток и идентификатор снимка остаются на месте', async () => {
    const cms = await stub();
    const dir = outDir();

    const run = await runCapture({ CMS_URL: cms.url, CONTENT_SNAPSHOT_DIR: dir });
    expect(run.status, run.output).toBe(0);

    const snap = readSnapshot(dir);
    expect(String(snap.fingerprint), 'нет отпечатка содержимого').toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(snap.snapshotId), 'нет идентификатора снимка').toMatch(/^snap:[0-9a-f]{64}$/);
    expect(snap.pinned, 'живой снимок помечен закреплённым').not.toBe(true);
  });
});
