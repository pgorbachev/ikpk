/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`: артефакты перехода,
 * лежащие в репозитории — правила перенаправления, карта адресов, карта панелей и
 * модуль записей-заплаток расписания.
 *
 * Числа здесь ИЗМЕРЯЮТСЯ выражением по данным, а не сверяются с текстом спеки: сверка с
 * текстом подтверждает опечатку, а не факт (`AGENTS.md`).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const REDIRECTS = join(ROOT, 'deploy', 'nginx-redirects.conf');
const URL_MAP = join(ROOT, 'discovery', 'url_map.csv');
const INSTITUTES = join(ROOT, 'discovery', 'entities', 'institutes.json');
const PANELS = join(ROOT, 'discovery', 'entities', 'collapsible_panels.json');

function instituteIdentifiers(): string[] {
  expect(existsSync(INSTITUTES), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${INSTITUTES}`).toBe(true);
  const json = JSON.parse(readFileSync(INSTITUTES, 'utf-8')) as { slug?: string }[];
  const slugs = json.map((i) => i.slug).filter((s): s is string => typeof s === 'string' && s.length > 0);
  expect(slugs.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: идентификаторов институтов нет').toBeGreaterThan(0);
  return slugs;
}

const firstSegment = (address: string): string =>
  address
    .replace(/^https?:\/\/[^/]+/, '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)[0] ?? '';

describe('переход на плоскую схему: цели перенаправлений', () => {
  // Scenario: цели перенаправлений не остались иерархическими
  it('ни одно правило не ведёт на адрес, начинающийся с идентификатора института', () => {
    expect(existsSync(REDIRECTS), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${REDIRECTS}`).toBe(true);
    const conf = readFileSync(REDIRECTS, 'utf-8');
    const targets = [...conf.matchAll(/return\s+301\s+([^;\s]+)\s*;/g)].map((m) => m[1]);
    expect(targets.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: правил с ответом 301 не найдено').toBeGreaterThan(0);

    const institutes = instituteIdentifiers();
    const hierarchical = targets.filter((t) => institutes.includes(firstSegment(t)));
    expect(
      hierarchical.length,
      `правил, ведущих в адрес, которого после перехода не существует: ${hierarchical.length} из ${targets.length}\n` +
        hierarchical.slice(0, 5).join('\n'),
    ).toBe(0);
  });

  it('карта адресов не назначает целью иерархический адрес', () => {
    expect(existsSync(URL_MAP), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${URL_MAP}`).toBe(true);
    const rows = readFileSync(URL_MAP, 'utf-8').trim().split('\n');
    const header = rows[0].split(',');
    const column = header.indexOf('new_path');
    expect(column, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: в карте адресов нет колонки new_path: ${rows[0]}`).toBeGreaterThanOrEqual(
      0,
    );
    const data = rows.slice(1);
    expect(data.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: карта адресов пуста').toBeGreaterThan(0);

    const institutes = instituteIdentifiers();
    const hierarchical = data
      .map((row) => row.split(',')[column] ?? '')
      .filter((path) => institutes.includes(firstSegment(path)));
    expect(
      hierarchical.length,
      `строк карты адресов с иерархической целью: ${hierarchical.length} из ${data.length}`,
    ).toBe(0);
  });
});

describe('перенос восстановленных панелей: карта «адрес и заголовок → поле»', () => {
  /**
   * Карта — артефакт репозитория; её место сессией тестов не назначается жёстко,
   * принимается любое из кандидатных. Красной проверка сегодня становится не из-за
   * имени, а потому что карты нет ни одной.
   */
  const CANDIDATES = [
    join(ROOT, 'discovery', 'panel-field-map.json'),
    join(ROOT, 'scripts', 'panel-field-map.json'),
    join(ROOT, 'discovery', 'entities', 'panel_field_map.json'),
  ];

  function panels(): Record<string, Record<string, string>> {
    expect(existsSync(PANELS), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${PANELS}`).toBe(true);
    const json = JSON.parse(readFileSync(PANELS, 'utf-8')) as Record<string, Record<string, string>>;
    expect(Object.keys(json).length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: панелей нет вовсе').toBeGreaterThan(0);
    return json;
  }

  it('карта существует', () => {
    const found = CANDIDATES.filter((f) => existsSync(f));
    expect(
      found.map((f) => relative(ROOT, f)),
      `исчерпывающей карты панелей нет ни в одном из мест: ${CANDIDATES.map((f) => relative(ROOT, f)).join(', ')}`,
    ).not.toEqual([]);
  });

  // Scenario: содержимое панелей оказалось в полях сущностей (часть, проверяемая без
  // прогона переноса: КАРТА обязана быть исчерпывающей — панель без поля останавливает
  // перенос, значит непокрытая панель есть остановка, назначенная заранее).
  it('карта покрывает каждую панель: пар «адрес и заголовок» без поля нет', () => {
    const registry = CANDIDATES.find((f) => existsSync(f));
    expect(registry, 'карты нет — покрытие считать не от чего').toBeDefined();
    const map = JSON.parse(readFileSync(registry!, 'utf-8')) as Record<string, Record<string, string>>;

    const uncovered: string[] = [];
    const source = panels();
    for (const [url, byHeading] of Object.entries(source)) {
      for (const heading of Object.keys(byHeading)) {
        const field = map[url]?.[heading];
        if (typeof field !== 'string' || field.length === 0) uncovered.push(`${url} :: ${heading}`);
      }
    }
    expect(uncovered.length, `панелей без поля в карте: ${uncovered.length}\n${uncovered.slice(0, 5).join('\n')}`).toBe(
      0,
    );
  });

  // Предмет шире четырёх секций семинара: 39 различных заголовков на 96 страницах.
  // Число измеряется здесь же, чтобы проверка не отстала от данных молча.
  it('в карту входят все различные заголовки, а не только секции семинара', () => {
    const registry = CANDIDATES.find((f) => existsSync(f));
    expect(registry).toBeDefined();
    const map = JSON.parse(readFileSync(registry!, 'utf-8')) as Record<string, Record<string, string>>;

    const sourceHeadings = new Set<string>();
    for (const byHeading of Object.values(panels())) for (const h of Object.keys(byHeading)) sourceHeadings.add(h);
    const mapped = new Set<string>();
    for (const byHeading of Object.values(map)) for (const h of Object.keys(byHeading)) mapped.add(h);

    const missing = [...sourceHeadings].filter((h) => !mapped.has(h));
    expect(missing, `заголовков панелей вне карты: ${missing.length} из ${sourceHeadings.size}`).toEqual([]);
  });
});

describe('модуль записей-заплаток расписания', () => {
  // Scenario: модуль заплаток отключается не раньше переключения источника.
  // Проверка ЗЕЛЁНАЯ по замыслу и сторожит преждевременное отключение: снятие модуля до
  // того, как сборка начнёт брать события из системы управления, удаляет события у
  // посетителя. Само отключение выполняет change `cms-content-publication`.
  it('модуль продолжает участвовать в сборке страницы расписания', () => {
    const module = join(ROOT, 'web', 'src', 'lib', 'schedule-supplements.ts');
    const page = join(ROOT, 'web', 'src', 'pages', 'raspisanie-i-tseny.astro');
    expect(existsSync(module), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${module}`).toBe(true);
    expect(existsSync(page), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${page}`).toBe(true);
    const source = readFileSync(page, 'utf-8');
    expect(
      /scheduleSupplements/.test(source),
      'модуль заплаток снят со страницы расписания раньше переключения источника: события исчезли у посетителя',
    ).toBe(true);
  });

  it('содержимое заплаток не пусто: переносить есть что', () => {
    const module = join(ROOT, 'web', 'src', 'lib', 'schedule-supplements.ts');
    const source = readFileSync(module, 'utf-8');
    expect(
      /startAt|endAt|seminar/.test(source),
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: в модуле заплаток не найдено ни одного события',
    ).toBe(true);
  });
});
