import { describe, it, expect } from 'vitest';
import {
  MODULES,
  loadModule,
  type CaptureModule,
  type CaptureObservation,
  type ContractModule,
  type Snapshot,
  type TypeObservation,
} from './helpers/cms-content-publication-contract';

// Спека `cms-content-source`: требования «Снимок полон и снят на одном состоянии контента»,
// «Недоступный или неполный контент останавливает сборку», «Контракт данных проверяется до
// генерации страниц», «Снимок содержит только опубликованные записи».
//
// КРАСНЫЕ ПО ЗАМЫСЛУ: шага снятия снимка и проверки контракта ещё нет (tasks.md 3.4–3.8).

const captureModule = (): Promise<CaptureModule> => loadModule<CaptureModule>(MODULES.capture);
const contractModule = (): Promise<ContractModule> => loadModule<ContractModule>(MODULES.contract);

const records = (n: number, prefix = 'r'): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}` }));

const observationOf = (types: TypeObservation[], overrides: Partial<CaptureObservation> = {}): CaptureObservation => ({
  types,
  stateAtStart: 'state-1',
  stateAtEnd: 'state-1',
  reachable: true,
  ...overrides,
});

/** Полный корректный обход всех каркасных типов — опора для одиночных мутаций. */
const healthyTypes = (): TypeObservation[] => [
  { type: 'institutes', declaredCount: 2, records: records(2, 'inst'), pages: [1] },
  { type: 'programs', declaredCount: 3, records: records(3, 'prog'), pages: [1] },
  { type: 'seminars', declaredCount: 4, records: records(4, 'sem'), pages: [1, 2] },
  { type: 'articles', declaredCount: 68, records: records(68, 'art'), pages: [1, 2, 3] },
  { type: 'teachers', declaredCount: 5, records: records(5, 'teach'), pages: [1] },
  { type: 'news', declaredCount: 0, records: [], pages: [1] },
];

const kinds = (failures: { kind: string }[]): string[] => failures.map((f) => f.kind);

describe('снятие снимка: полнота и одно состояние', () => {
  it('исправный обход проходит — иначе одиночные мутации ниже ничего не доказывают', async () => {
    const mod = await captureModule();
    const result = mod.assessCapture(observationOf(healthyTypes()));
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Сценарий: полученное число записей меньше объявленного
  it('усечённый успешный ответ — неуспех, а не «контента стало меньше»', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[3] = { type: 'articles', declaredCount: 68, records: records(20, 'art'), pages: [1] };

    const result = mod.assessCapture(observationOf(types));
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('truncated');
    expect(result.failures.some((f) => f.type === 'articles')).toBe(true);
  });

  // Сценарий: контент изменился во время обхода
  it('различие состояния на начало и конец обхода отбрасывает снимок', async () => {
    const mod = await captureModule();
    const result = mod.assessCapture(
      observationOf(healthyTypes(), { stateAtStart: 'state-1', stateAtEnd: 'state-2' }),
    );
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('changed-during-capture');
  });

  // Сценарий: страница постраничной выдачи пропущена
  it('пропуск страницы постраничной выдачи — неуспех', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[3] = { type: 'articles', declaredCount: 68, records: records(68, 'art'), pages: [1, 3] };
    expect(kinds(mod.assessCapture(observationOf(types)).failures)).toContain('pagination-gap');
  });

  it('повтор страницы постраничной выдачи — тоже неуспех', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[3] = { type: 'articles', declaredCount: 68, records: records(68, 'art'), pages: [1, 2, 2] };
    expect(kinds(mod.assessCapture(observationOf(types)).failures)).toContain('pagination-gap');
  });
});

describe('снятие снимка: недоступный и неполный контент', () => {
  // Сценарий: система управления недоступна
  it('недоступная система управления — неуспех', async () => {
    const mod = await captureModule();
    const result = mod.assessCapture(observationOf([], { reachable: false }));
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('unreachable');
  });

  // Сценарий: часть сущностей получена
  it('ошибка одного запроса при успехе остальных — неуспех, частичный снимок не собирается', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[2] = { type: 'seminars', declaredCount: 4, records: [], requestFailed: true };
    const result = mod.assessCapture(observationOf(types));
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('request-failed');
  });

  // Сценарий: пустой список каркасного типа
  it('пустой список семинаров — неуспех, а не сайт без каталога', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[2] = { type: 'seminars', declaredCount: 0, records: [], pages: [1] };
    const result = mod.assessCapture(observationOf(types));
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('below-minimum-cardinality');
  });

  it('минимальная мощность: каркасные типы больше нуля, законно пустые — ноль', async () => {
    const mod = await captureModule();
    for (const type of ['institutes', 'programs', 'seminars', 'articles', 'teachers']) {
      expect(mod.MINIMUM_CARDINALITY[type], `каркасный тип ${type}`).toBeGreaterThan(0);
    }
    for (const type of ['news', 'promos']) {
      expect(mod.MINIMUM_CARDINALITY[type], `законно пустой тип ${type}`).toBe(0);
    }
  });

  // Сценарий: последняя новость удалена
  it('объявленный ноль там, где ноль допустим, — законное состояние', async () => {
    const mod = await captureModule();
    const result = mod.assessCapture(observationOf(healthyTypes()));
    expect(result.ok).toBe(true);
  });

  // Сценарий: количество записей неизвестно
  it('неизвестное количество при пустом списке — неуспех: «ноль» и «не удалось узнать» различны', async () => {
    const mod = await captureModule();
    const types = healthyTypes();
    types[5] = { type: 'news', declaredCount: null, records: [], pages: [1] };
    const result = mod.assessCapture(observationOf(types));
    expect(result.ok).toBe(false);
    expect(kinds(result.failures)).toContain('unknown-count');
  });
});

describe('снимок содержит только опубликованные записи', () => {
  // Сценарии: черновик не попадает в снимок; снятая с публикации запись не попадает в снимок
  it('черновики и снятые с публикации записи в снимок не попадают', async () => {
    const mod = await captureModule();
    const source = [
      { id: 'a-1', publishedAt: '2026-01-01T00:00:00Z' },
      { id: 'a-2', publishedAt: null }, // черновик
      { id: 'a-3', publishedAt: '2026-01-01T00:00:00Z', unpublishedAt: '2026-02-01T00:00:00Z' },
    ];
    // Требование записано явно, а не оставлено на умолчание системы управления: шаг снятия
    // снимка обязан сам отбирать опубликованные.
    const selected = mod.selectPublished(source);

    expect(selected.map((r) => r.id)).toEqual(['a-1']);
  });
});

describe('контракт данных проверяется до генерации страниц', () => {
  const snapshotWith = (types: Record<string, Record<string, unknown>[]>): Snapshot => ({
    content: { types, media: [] },
    referenceDate: '2026-08-24',
  });

  const wholeArticle = (slug: string): Record<string, unknown> => ({
    slug,
    title: `Статья ${slug}`,
    body: '<p>тело</p>',
    page_title: 'Заголовок',
    page_description: 'Описание',
    image: `/media/${slug}.jpg`,
  });

  const wholeSnapshot = (): Snapshot =>
    snapshotWith({
      institutes: [{ slug: 'inst-1', title: 'Институт' }],
      programs: [{ slug: 'prog-1', title: 'Программа', institute: 'inst-1' }],
      seminars: [{ slug: 'sem-1', title: 'Семинар', program: 'prog-1' }],
      teachers: [{ slug: 'teach-1', name: 'Преподаватель', institute: 'inst-1' }],
      articles: [wholeArticle('alpha'), wholeArticle('beta')],
      schedule: [{ id: 'ev-1', seminar: 'sem-1', startAt: '2026-09-01' }],
    });

  it('целый снимок нарушений не даёт — опора для одиночных мутаций', async () => {
    const mod = await contractModule();
    const result = mod.validateSnapshotContract(wholeSnapshot());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Сценарий: запись без обязательного поля
  it('пустое описание страницы у статьи названо записью и полем', async () => {
    const mod = await contractModule();
    const snapshot = wholeSnapshot();
    (snapshot.content.types.articles[1] as Record<string, unknown>).page_description = '';

    const result = mod.validateSnapshotContract(snapshot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ type: 'articles', recordId: 'beta', field: 'page_description', rule: 'required-field-empty' }),
    );
  });

  // Сценарий: оборванная связь
  it('семинар без программы — неуспех с указанием записи', async () => {
    const mod = await contractModule();
    const snapshot = wholeSnapshot();
    delete (snapshot.content.types.seminars[0] as Record<string, unknown>).program;

    const result = mod.validateSnapshotContract(snapshot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ type: 'seminars', recordId: 'sem-1', rule: 'broken-relation' }),
    );
  });

  it('программа без института и преподаватель без института — тоже оборванные связи', async () => {
    const mod = await contractModule();
    const snapshot = wholeSnapshot();
    (snapshot.content.types.programs[0] as Record<string, unknown>).institute = 'inst-missing';
    (snapshot.content.types.teachers[0] as Record<string, unknown>).institute = 'inst-missing';

    const violations = mod.validateSnapshotContract(snapshot).violations;
    expect(violations.filter((v) => v.rule === 'broken-relation').map((v) => v.type).sort()).toEqual([
      'programs',
      'teachers',
    ]);
  });

  it('событие расписания без семинара — оборванная связь', async () => {
    const mod = await contractModule();
    const snapshot = wholeSnapshot();
    (snapshot.content.types.schedule[0] as Record<string, unknown>).seminar = 'sem-missing';
    expect(mod.validateSnapshotContract(snapshot).violations).toContainEqual(
      expect.objectContaining({ type: 'schedule', recordId: 'ev-1', rule: 'broken-relation' }),
    );
  });

  // Сценарий: повторяющийся идентификатор
  it('два семинара одной программы с одинаковым идентификатором — названы ОБЕ записи', async () => {
    const mod = await contractModule();
    const snapshot = wholeSnapshot();
    snapshot.content.types.seminars = [
      { slug: 'sem-1', title: 'Первый', program: 'prog-1' },
      { slug: 'sem-1', title: 'Второй', program: 'prog-1' },
    ];

    const result = mod.validateSnapshotContract(snapshot);
    expect(result.ok).toBe(false);
    const duplicate = result.violations.find((v) => v.rule === 'duplicate-identifier');
    expect(duplicate, 'нарушение duplicate-identifier не найдено').toBeDefined();
    expect(duplicate?.relatedRecordIds?.length, 'названы обе записи, а не одна').toBe(2);
  });
});

// ─── Спека `article-catalog`, требование «Целостность источника каталога» ────────────────
//
// Проверка выполняется на СНИМКЕ до генерации страниц и обязана быть выполнима без обращения
// к живой системе управления — иначе её результат перестаёт различать дефект кода и изменение
// контента.
describe('целостность источника каталога', () => {
  const catalogSnapshot = (articles: Record<string, unknown>[]): Snapshot => ({
    content: { types: { articles }, media: [] },
    referenceDate: '2026-08-24',
  });

  const catalogArticle = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    slug: 'kineziologiya',
    title: 'Кинезиология',
    body: '<p>тело</p>',
    page_title: 'Кинезиология — ИКПК',
    page_description: 'О кинезиологии',
    image: '/media/kin.jpg',
    ...over,
  });

  // Сценарий: обязательные поля заполнены
  it.each([
    ['slug'],
    ['title'],
    ['body'],
    ['page_title'],
    ['page_description'],
    ['image'],
  ])('пустое поле %s статьи — нарушение контракта', async (field) => {
    const mod = await contractModule();
    const snapshot = catalogSnapshot([catalogArticle(), catalogArticle({ slug: 'vtoraya', [field]: '' })]);

    const violations = mod.validateSnapshotContract(snapshot).violations;
    expect(violations.some((v) => v.field === field && v.rule === 'required-field-empty'), field).toBe(true);
  });

  // Сценарий: идентификаторы уникальны и безопасны для адреса
  it('совпадающие slug статей — нарушение с указанием обеих записей', async () => {
    const mod = await contractModule();
    const snapshot = catalogSnapshot([catalogArticle(), catalogArticle()]);

    const duplicate = mod
      .validateSnapshotContract(snapshot)
      .violations.find((v) => v.rule === 'duplicate-identifier');
    expect(duplicate).toBeDefined();
    expect(duplicate?.relatedRecordIds?.length).toBe(2);
  });

  it.each([
    ['с пробелом', 'две статьи'],
    ['с кириллицей', 'кинезиология'],
    ['со слэшем', 'razdel/statya'],
    ['со знаком вопроса', 'statya?x=1'],
    ['с процентом', 'statya%20'],
  ])('slug %s изменится при кодировании адреса — нарушение', async (_label, slug) => {
    const mod = await contractModule();
    const violations = mod.validateSnapshotContract(catalogSnapshot([catalogArticle({ slug })])).violations;
    expect(violations.some((v) => v.rule === 'slug-not-url-safe'), slug).toBe(true);
  });

  it('обычный slug нарушением не считается — иначе проверка красит всё подряд', async () => {
    const mod = await contractModule();
    const result = mod.validateSnapshotContract(catalogSnapshot([catalogArticle({ slug: 'chto-takoe-kineziologiya' })]));
    expect(result.violations).toEqual([]);
  });

  // Сценарий: нарушение контракта останавливает сборку
  it('нарушение останавливает сборку и называет запись и условие', async () => {
    const mod = await contractModule();
    const snapshot = catalogSnapshot([catalogArticle({ slug: 'bez-opisaniya', page_description: '' })]);

    expect(() => mod.assertSnapshotContract(snapshot)).toThrow(/bez-opisaniya/);
    expect(() => mod.assertSnapshotContract(snapshot)).toThrow(/page_description/);
    // Целый снимок сборку не останавливает.
    expect(() => mod.assertSnapshotContract(catalogSnapshot([catalogArticle()]))).not.toThrow();
  });
});
