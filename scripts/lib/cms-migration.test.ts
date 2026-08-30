/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`: перенос контента —
 * повторяемость, контрольная точка, полнота прежних адресов, карта панелей,
 * заключительная сверка и годность материала переноса.
 *
 * Реализации нет — модуль `./cms-migration.ts` подгружается динамически.
 *
 * Здесь НЕ проверяется код выхода самого переноса и число созданных записей: перенос
 * пишет в развёрнутый Strapi, которого сегодня нет, и подделывать его моком значило бы
 * получить проверку, проходящую независимо от факта. Такие сценарии перечислены в конце
 * файла с названной причиной.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMigration, makeRevisionStore, type PanelMapEntry } from './cms-authoring-contract';

const importFunction = (name: string, next: string): string => {
  const source = readFileSync(join(import.meta.dirname, '..', 'import.ts'), 'utf-8');
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`function ${next}`, start + 1);
  expect(start, `в import.ts нет ${name}`).toBeGreaterThanOrEqual(0);
  expect(end, `в import.ts нет следующей функции ${next}`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('перенос: wiring порядка и вычисляемого статуса семинара', () => {
  it.each([
    ['importInstitutes', 'importTeachers'],
    ['importTeachers', 'importArticles'],
    ['importCourseGroups', 'importSeminars'],
    ['importSeminars', 'importScheduleEntries'],
  ])('%s переносит явное поле order', (name, next) => {
    expect(importFunction(name, next)).toMatch(/\border\s*:/);
  });

  it('импорт семинара не возвращает удалённое хранимое поле status', () => {
    expect(importFunction('importSeminars', 'importScheduleEntries')).not.toMatch(/\bstatus\s*:/);
  });
});

describe('перенос: связи расписания соответствуют схеме CMS', () => {
  it('состояние события записывается в поле CMS, не занятое Draft & Publish', () => {
    const source = importFunction('importScheduleEntries', 'printReport');
    expect(source).toMatch(/\beventStatus\s*:\s*\(e\.status as string\)/);
    expect(source).not.toMatch(/\n\s*status\s*:/);
  });

  it('преподаватели события разрешаются в documentId и записываются relation payload', () => {
    const source = importFunction('importScheduleEntries', 'printReport');

    expect(source).toMatch(/loadJSON\(["']teachers\.json["']\)/);
    expect(source).toMatch(/resolveRelation\(\s*["']teachers["']/);
    expect(source).toMatch(/data\.teachers\s*=\s*\{\s*set\s*:/);
    expect(source).not.toMatch(/teachers:\s*Array\.isArray\(e\.teachers\)/);
  });
});

describe('перенос: состав института хранится связью с персоной', () => {
  it('импорт персоны разрешает исходный институт в documentId и записывает relation payload', () => {
    const source = importFunction('importTeachers', 'importArticles');

    expect(source).toMatch(/resolveRelation\(\s*["']institutes["']/);
    expect(source).toMatch(/data\.institutes\s*=\s*\{\s*set\s*:/);
    expect(source).not.toMatch(/data\.institute_legacy_id\s*=/);
  });
});

describe('перенос: даты новостей и акций сохраняют исходный момент', () => {
  it.each([
    ['importNewsItems', 'importPromotions'],
    ['importPromotions', 'importCourseGroups'],
  ])('%s переносит createdAt в публикационное поле date', (name, next) => {
    expect(importFunction(name, next)).toMatch(/date:\s*\(e\.createdAt as string\)/);
  });
});

describe('перенос: контрольная точка предыдущего прогона', () => {
  // Scenario: повторный перенос не затирает правку редактора
  it('расхождение с контрольной точкой останавливает перенос и называет запись', async () => {
    const { checkpointVerdict } = await loadMigration();
    const verdict = checkpointVerdict({
      recordId: 'seminar:cst-1',
      current: 'rev-editor',
      checkpoint: { recordId: 'seminar:cst-1', revision: 'rev-import' },
    });
    expect(verdict.action).toBe('stop');
    expect(verdict.message).toMatch(/cst-1/);
  });

  it('совпадение с контрольной точкой позволяет запись', async () => {
    const { checkpointVerdict } = await loadMigration();
    expect(
      checkpointVerdict({
        recordId: 'seminar:cst-1',
        current: 'rev-import',
        checkpoint: { recordId: 'seminar:cst-1', revision: 'rev-import' },
      }).action,
    ).toBe('write');
  });

  it('первый прогон пишет запись, которой в системе управления ещё нет', async () => {
    const { checkpointVerdict } = await loadMigration();
    expect(checkpointVerdict({ recordId: 'seminar:new', current: undefined }).action).toBe('write');
  });

  // Scenario: сверка внутри одного прогона правку между прогонами не ловит.
  // Существующая запись без контрольной точки предыдущего прогона неотличима от
  // отредактированной, поэтому единственный допустимый исход — остановка.
  it('существующая запись без контрольной точки не перезаписывается', async () => {
    const { checkpointVerdict } = await loadMigration();
    const verdict = checkpointVerdict({ recordId: 'seminar:cst-1', current: 'rev-editor' });
    expect(
      verdict.action,
      'запись без контрольной точки перезаписана: сверка стережёт только один прогон',
    ).toBe('stop');
  });

  // Scenario: правка между сравнением и записью не затирается
  it('запись выполняется условно по ожидаемой ревизии', async () => {
    const { applyRecord } = await loadMigration();
    const store = makeRevisionStore({ 'seminar:cst-1': { revision: 'rev-import', value: 'legacy' } });

    // Редактор сохранил свою правку после сравнения, но до записи переноса.
    store.setOutOfBand('seminar:cst-1', 'rev-editor', 'правка редактора');

    const result = applyRecord({
      store,
      recordId: 'seminar:cst-1',
      expectedRevision: 'rev-import',
      value: 'legacy',
    });
    expect(result.applied, 'безусловная запись затёрла правку редактора').toBe(false);
    expect(store.read('seminar:cst-1')?.value).toBe('правка редактора');
    expect(result.reason).toMatch(/cst-1|ревизи/i);
  });

  it('запись применяется, когда ревизия не менялась', async () => {
    const { applyRecord } = await loadMigration();
    const store = makeRevisionStore({ 'seminar:cst-1': { revision: 'rev-import', value: 'legacy' } });
    const result = applyRecord({
      store,
      recordId: 'seminar:cst-1',
      expectedRevision: 'rev-import',
      value: 'обновлено',
    });
    expect(result.applied, result.reason).toBe(true);
    expect(store.read('seminar:cst-1')?.value).toBe('обновлено');
  });

  // Scenario: повторный запуск завершает частично перенесённую запись
  it('частично перенесённая запись доводится или заменяется, а не пропускается', async () => {
    const { resumeVerdict } = await loadMigration();
    const verdict = resumeVerdict({
      recordId: 'seminar:cst-1',
      cmsRecord: { legacy_id: 'cst-1', name: 'CST-1' },
      requiredRelations: ['course_group'],
    });
    expect(verdict.action, 'запись пропущена по факту существования легаси-идентификатора').not.toBe(
      'skip',
    );
    expect(verdict.complete, 'неполная запись объявлена готовой').toBe(false);
  });

  it('полная запись готовой и признаётся', async () => {
    const { resumeVerdict } = await loadMigration();
    const verdict = resumeVerdict({
      recordId: 'seminar:cst-1',
      cmsRecord: { legacy_id: 'cst-1', name: 'CST-1', course_group: 'p1' },
      requiredRelations: ['course_group'],
    });
    expect(verdict.complete, verdict.message).toBe(true);
  });
});

describe('перенос: повторяемость медиа опирается на содержимое, не на память прогона', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  // Scenario: повторный запуск не дублирует файлы медиатеки (часть, проверяемая чисто)
  it('один и тот же файл даёт один и тот же ключ в разных вызовах', async () => {
    const { mediaKey } = await loadMigration();
    const first = mediaKey({ bytes: bytes('картинка'), sourceUrl: 'https://ikpk.su/a.jpg' });
    const second = mediaKey({ bytes: bytes('картинка'), sourceUrl: 'https://ikpk.su/a.jpg' });
    expect(first).toBe(second);
    expect(first.length, 'ключ пуст — по нему ничего не различишь').toBeGreaterThan(0);
  });

  it('разное содержимое даёт разные ключи', async () => {
    const { mediaKey } = await loadMigration();
    expect(mediaKey({ bytes: bytes('одна'), sourceUrl: 'https://ikpk.su/a.jpg' })).not.toBe(
      mediaKey({ bytes: bytes('другая'), sourceUrl: 'https://ikpk.su/a.jpg' }),
    );
  });

  it('одно содержимое под двумя адресами не удваивает медиатеку', async () => {
    const { mediaKey } = await loadMigration();
    expect(mediaKey({ bytes: bytes('одна'), sourceUrl: 'https://ikpk.su/a.jpg' })).toBe(
      mediaKey({ bytes: bytes('одна'), sourceUrl: 'https://ikpk.su/copy/a.jpg' }),
    );
  });
});

describe('перенос: прежние адреса', () => {
  // Scenario: пересчёт покрытия прежних адресов сходится
  it('число записей с прежним адресом равно числу перенесённых', async () => {
    const { previousAddressCoverage } = await loadMigration();
    const result = previousAddressCoverage({
      migrated: [
        { id: 's1', previousAddresses: ['/institut-apledzhera/dolgoletie/cst-1'] },
        { id: 't1', previousAddresses: ['/teachers/12', '/institut-apledzhera/prepodavatel/12'] },
      ],
    });
    expect(result.migratedCount).toBe(2);
    expect(result.withPreviousAddress).toBe(2);
    expect(result.ok, result.missing.join(', ')).toBe(true);
  });

  // Scenario: запись без известного прежнего адреса останавливает перенос
  it('запись без прежнего адреса роняет сверку и называется', async () => {
    const { previousAddressCoverage } = await loadMigration();
    const result = previousAddressCoverage({
      migrated: [
        { id: 's1', previousAddresses: ['/seminary/cst-1'] },
        { id: 's2', previousAddresses: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['s2']);
    expect(
      result.withPreviousAddress,
      'сверка сделана выборкой: непокрытая запись не уменьшила число',
    ).toBe(1);
  });

  // Прежних адресов у записи может быть ДВА, и оба обязаны попасть в историю.
  it('два различных прежних адреса сохраняются оба', async () => {
    const { previousAddressCoverage } = await loadMigration();
    const result = previousAddressCoverage({
      migrated: [{ id: 't1', previousAddresses: ['/teachers/12', '/institut-apledzhera/prepodavatel/12'] }],
    });
    expect(result.ok).toBe(true);
    expect(result.withPreviousAddress).toBe(1);
  });
});

describe('перенос: карта панелей', () => {
  const map: PanelMapEntry[] = [
    { url: '/institut-apledzhera/dolgoletie/cst-1', heading: 'Учебный план', field: 'seminar.learningPlan' },
    { url: '/kontakty', heading: 'Как добраться', field: 'page.body' },
  ];

  // Scenario: панель без соответствия в карте останавливает перенос
  it('панель, которой карта не даёт поля, останавливает перенос с указанием адреса и заголовка', async () => {
    const { panelField } = await loadMigration();
    const result = panelField({ url: '/oplata', heading: 'Как оплатить', map });
    expect('stop' in result, 'неизвестная панель молча пропущена').toBe(true);
    if ('stop' in result) {
      expect(result.message).toMatch(/\/oplata/);
      expect(result.message).toMatch(/Как оплатить/);
    }
  });

  it('панель из карты даёт своё поле', async () => {
    const { panelField } = await loadMigration();
    const result = panelField({ url: '/kontakty', heading: 'Как добраться', map });
    expect(result).toEqual({ field: 'page.body' });
  });

  // Сопоставление по адресу И заголовку, а не по одному заголовку: один и тот же
  // заголовок встречается на разных страницах и означает разные поля.
  it('совпадение заголовка при другом адресе панелью из карты не считается', async () => {
    const { panelField } = await loadMigration();
    const result = panelField({ url: '/statyi', heading: 'Учебный план', map });
    expect('stop' in result).toBe(true);
  });
});

describe('перенос: состояние сведений о документах выводится из исходного материала', () => {
  // Scenario: перенос не выводит «не выдаются» из отсутствия сведений
  it('отсутствие панели даёт «сведения не подтверждены», а не «не выдаются»', async () => {
    const { documentsStateFromSource } = await loadMigration();
    expect(documentsStateFromSource({ hasDocumentsPanel: false })).toBe('unconfirmed');
  });

  it('наличие панели не даёт «не подтверждено»', async () => {
    const { documentsStateFromSource } = await loadMigration();
    expect(documentsStateFromSource({ hasDocumentsPanel: true })).not.toBe('unconfirmed');
  });
});

describe('перенос: заключительная сверка', () => {
  // Scenario: расхождение числа записей останавливает переключение
  it('расхождение числа записей названо типом и обоими числами', async () => {
    const { reconcile } = await loadMigration();
    const result = reconcile({
      source: [{ type: 'seminar', ids: ['a', 'b', 'c'] }],
      cms: [{ type: 'seminar', ids: ['a', 'b'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.countMismatch).toEqual([{ type: 'seminar', source: 3, cms: 2 }]);
  });

  // Scenario: удалённая на старом сайте запись обнаружена
  it('запись, существующая только в системе управления, названа как удаление', async () => {
    const { reconcile } = await loadMigration();
    const result = reconcile({
      source: [{ type: 'seminar', ids: ['a'] }],
      cms: [{ type: 'seminar', ids: ['a', 'udalennyj'] }],
    });
    expect(result.ok).toBe(false);
    expect(result.deletions).toEqual([{ type: 'seminar', id: 'udalennyj' }]);
  });

  // Scenario: расхождение состава медиа обнаружено
  it('отсутствующий в системе управления медиафайл назван вместе с записью', async () => {
    const { reconcile } = await loadMigration();
    const result = reconcile({
      source: [{ type: 'article', ids: ['a1'] }],
      cms: [{ type: 'article', ids: ['a1'] }],
      mediaReferences: [{ recordId: 'a1', file: 'kartinka.jpg' }],
      cmsMedia: [],
    });
    expect(result.ok).toBe(false);
    expect(result.mediaMissing).toEqual([{ recordId: 'a1', file: 'kartinka.jpg' }]);
  });

  it('совпадающее состояние сверку проходит', async () => {
    const { reconcile } = await loadMigration();
    const result = reconcile({
      source: [{ type: 'article', ids: ['a1'] }],
      cms: [{ type: 'article', ids: ['a1'] }],
      mediaReferences: [{ recordId: 'a1', file: 'kartinka.jpg' }],
      cmsMedia: ['kartinka.jpg'],
    });
    expect(result.ok, result.message).toBe(true);
  });
});

describe('перенос: материал сверки представляет одно состояние старого сайта', () => {
  // Scenario: дамп таблиц без покрытия медиа атомарным не считается
  it('дамп таблиц с манифестом медиа без покрытия не принимается', async () => {
    const { acceptMaterial } = await loadMigration();
    const verdict = acceptMaterial({ method: 'atomic-dump', mediaCoverage: 'none' });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/меди|media/i);
  });

  it.each(['freeze', 'storage-snapshot', 'proven-immutable', 'byte-mark'] as const)(
    'дамп таблиц с покрытием медиа (%s) принимается',
    async (mediaCoverage) => {
      const { acceptMaterial } = await loadMigration();
      const verdict = acceptMaterial({ method: 'atomic-dump', mediaCoverage });
      expect(verdict.ok, verdict.message).toBe(true);
    },
  );

  // Scenario: источник изменился во время обхода
  it('расхождение отметки состояния на концах обхода отбрасывает материал', async () => {
    const { acceptMaterial } = await loadMigration();
    const verdict = acceptMaterial({
      method: 'crawl-with-revision',
      revisionBefore: 'r1',
      revisionAfter: 'r2',
      revisionCoversMediaBytes: true,
    });
    expect(verdict.ok).toBe(false);
  });

  it('обход принимается только при отметке, меняющейся на изменение байтов медиа', async () => {
    const { acceptMaterial } = await loadMigration();
    expect(
      acceptMaterial({
        method: 'crawl-with-revision',
        revisionBefore: 'r1',
        revisionAfter: 'r1',
        revisionCoversMediaBytes: false,
      }).ok,
      'принята отметка, не покрывающая замену байтов медиа',
    ).toBe(false);
    expect(
      acceptMaterial({
        method: 'crawl-with-revision',
        revisionBefore: 'r1',
        revisionAfter: 'r1',
        revisionCoversMediaBytes: true,
      }).ok,
    ).toBe(true);
  });

  it('заморозка редактирования принимается без дополнительных условий', async () => {
    const { acceptMaterial } = await loadMigration();
    expect(acceptMaterial({ method: 'freeze' }).ok).toBe(true);
  });
});

/*
 * СЦЕНАРИИ ЭТИХ ТРЕБОВАНИЙ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * Причина у всех одна и она названа: предмет — прогон переноса против РАЗВЁРНУТОГО
 * Strapi, которого сегодня нет ни в репозитории, ни в CI. Мок Strapi проверял бы
 * собственную заглушку, то есть проходил бы независимо от факта — ровно тот класс
 * декоративного гейта, который запрещён `AGENTS.md`. Проверка — интеграционная, после
 * развёртывания, со свидетельством (команда, код выхода, числа до и после):
 *
 * - «повторный запуск не создаёт дублей» (число записей каждого типа);
 * - «повторный запуск не дублирует файлы медиатеки» (число файлов и та же ссылка);
 * - «потерянная связь даёт неуспех» (ненулевой код выхода, запись названа);
 * - «неудачная загрузка файла посчитана» (неуспех, число названо);
 * - «содержимое панелей оказалось в полях сущностей» (состояние после прогона);
 * - «заплатки расписания перенесены или отброшены осознанно» (отчёт прогона).
 *
 * Чисто вычислимые части этих сценариев проверены выше: ключ повторяемости медиа,
 * контрольная точка, условная запись, доведение частичной записи, карта панелей.
 */
