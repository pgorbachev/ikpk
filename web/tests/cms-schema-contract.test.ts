/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`: СХЕМА системы
 * управления как носитель контракта.
 *
 * Предмет — файлы `cms/src/api/*&#47;content-types/*&#47;schema.json`, `cms/src/components/**`
 * и `cms/config/*`. Это единственная часть системы управления, которая существует в
 * репозитории: развёрнутого Strapi нет ни здесь, ни в CI, поэтому поведение живой
 * админки проверяется отдельно и вручную, а описанное схемой — здесь и машинно.
 *
 * Проверка обязана различать «нарушений нет» и «проверить не удалось»: отсутствие файла
 * схемы или неразбираемый JSON роняют тест с меткой ПРОВЕРИТЬ НЕ УДАЛОСЬ, а не проходят
 * на пустом множестве.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const API_DIR = join(ROOT, 'cms', 'src', 'api');

type Attribute = Record<string, unknown> & { type?: string };
type Schema = {
  kind?: string;
  info?: { singularName?: string };
  options?: Record<string, unknown>;
  pluginOptions?: Record<string, unknown>;
  attributes?: Record<string, Attribute>;
};

function schemaFiles(): { name: string; path: string }[] {
  expect(existsSync(API_DIR), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет каталога ${API_DIR}`).toBe(true);
  const found: { name: string; path: string }[] = [];
  for (const api of readdirSync(API_DIR)) {
    const contentTypes = join(API_DIR, api, 'content-types');
    if (!existsSync(contentTypes)) continue;
    for (const ct of readdirSync(contentTypes)) {
      const file = join(contentTypes, ct, 'schema.json');
      if (existsSync(file)) found.push({ name: ct, path: file });
    }
  }
  expect(found.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: ни одной схемы не найдено').toBeGreaterThan(0);
  return found;
}

const ALL = schemaFiles();

function schema(name: string): Schema {
  const entry = ALL.find((s) => s.name === name);
  expect(entry, `нет типа контента ${name}`).toBeDefined();
  try {
    return JSON.parse(readFileSync(entry!.path, 'utf-8')) as Schema;
  } catch (error) {
    throw new Error(`ПРОВЕРИТЬ НЕ УДАЛОСЬ: ${entry!.path} не разбирается`, { cause: error });
  }
}

const attr = (name: string, field: string): Attribute | undefined => schema(name).attributes?.[field];

/**
 * Тип персоны. Спека объединяет преподавателей и авторов методик в ОДИН тип «персона»,
 * но имени файла не назначает: сегодняшний тип называется `teacher`. Принимается любое
 * из двух имён — иначе тест проверял бы переименование, которого требование не просит.
 */
const PERSON = ALL.some((s) => s.name === 'person') ? 'person' : 'teacher';

describe('схема CMS: порядок следования', () => {
  // Требование «Порядок следования задаётся явно и воспроизводим» + таблица
  // обязательных полей (у института значение порядка обязательно).
  it.each(['institute', 'course-group', 'seminar'])('у типа %s есть целочисленное поле порядка', (name) => {
    const found = Object.entries(schema(name).attributes ?? {}).find(
      ([field, a]) => /order|poryadok|position|sort/i.test(field) && a.type === 'integer',
    );
    expect(found, `у ${name} нет целочисленного поля порядка — порядок задаётся алфавитом`).toBeDefined();
  });

  it('у персоны есть целочисленное поле порядка', () => {
    const found = Object.entries(schema(PERSON).attributes ?? {}).find(
      ([field, a]) => /order|position|sort/i.test(field) && a.type === 'integer',
    );
    expect(found, `у ${PERSON} нет целочисленного поля порядка`).toBeDefined();
  });

  it.each(['institute', 'course-group', 'seminar', PERSON])(
    'пустой порядок типа %s не превращается в ноль значением по умолчанию',
    (name) => {
      const found = Object.entries(schema(name).attributes ?? {}).find(
        ([field, a]) => /order|poryadok|position|sort/i.test(field) && a.type === 'integer',
      );
      expect(found, `у ${name} нет целочисленного поля порядка`).toBeDefined();
      expect(
        found![1],
        `${name}.${found![0]} задаёт default: пустая запись попадёт в начало вместо конца`,
      ).not.toHaveProperty('default');
    },
  );

  it('production data access использует общий сортировщик с лексикографическим tie-break', () => {
    const dataSource = readFileSync(join(ROOT, 'web', 'src', 'lib', 'data.ts'), 'utf-8');
    expect(dataSource).toMatch(/import\s*\{\s*byExplicitOrder\s*\}.*content-order/);
    expect(dataSource).not.toMatch(/function\s+byOrder\s*</);
  });
});

describe('схема CMS: статус семинара не хранится', () => {
  // Scenario: редактор не может задать статус напрямую.
  // Хранимый признак уже расходился с действительностью: 107 «запланированных» против 47.
  it('у семинара нет хранимого поля статуса', () => {
    const attributes = schema('seminar').attributes ?? {};
    const stored = Object.entries(attributes).filter(([field]) => /^status$/i.test(field));
    expect(stored, 'у семинара остался хранимый статус — редактору доступно поле статуса').toEqual([]);
  });

  it('у семинара нет поля со значением по умолчанию, независимым от расписания', () => {
    const attributes = schema('seminar').attributes ?? {};
    for (const [field, a] of Object.entries(attributes)) {
      if (/planned|status/i.test(field)) {
        expect(a, `${field} задаёт статус умолчанием, независимым от расписания`).not.toHaveProperty(
          'default',
        );
      }
    }
  });
});

describe('схема CMS: изображения множественные', () => {
  // D1/G3: множественное медиа-поле, первое изображение — основное.
  it.each(['seminar', 'course-group', 'institute'])('медиа-поле типа %s множественное', (name) => {
    const attributes = schema(name).attributes ?? {};
    const media = Object.entries(attributes).filter(([, a]) => a.type === 'media');
    expect(media.length, `у ${name} нет медиа-поля`).toBeGreaterThan(0);
    for (const [field, a] of media) {
      expect(a.multiple, `${name}.${field} остаётся одиночным изображением`).toBe(true);
    }
  });
});

describe('схема CMS: секции семинара — отдельные поля с однозначным смыслом', () => {
  // Requirement: Секции семинара — отдельные поля с однозначным смыслом.
  it('у семинара есть отдельные поля учебного плана, режима обучения и рекомендаций', () => {
    const attributes = schema('seminar').attributes ?? {};
    const names = Object.keys(attributes);
    const has = (re: RegExp) => names.some((n) => re.test(n));
    expect(has(/learning_?plan|uchebnyj|curriculum_plan/i), 'нет поля учебного плана').toBe(true);
    expect(has(/learning_?mode|mode_?of|rezhim|how_?it/i), 'нет поля режима обучения').toBe(true);
    expect(has(/recommendation/i), 'нет поля рекомендаций').toBe(true);
  });

  // Scenario: секция документов построена из структурных полей.
  // Поле произвольного содержимого о документах существовать не должно: оно даёт второй
  // источник истины, с которым структура может разойтись молча.
  it('поля произвольного содержимого о выдаваемых документах в модели нет', () => {
    const attributes = schema('seminar').attributes ?? {};
    const freeform = Object.entries(attributes).filter(
      ([field, a]) =>
        /certificate|document|diplom|udostoveren|svidetel/i.test(field) &&
        !/confirmation/i.test(field) &&
        (a.type === 'richtext' || a.type === 'text' || a.type === 'string' || a.type === 'blocks'),
    );
    expect(
      freeform.map(([f]) => f),
      'у семинара осталось поле произвольного содержимого о документах',
    ).toEqual([]);
  });

  // Тот же предмет со стороны сборки: модуль секций собирает страницу семинара, и пока
  // в нём есть поле `certificates`, свободный текст о документах продолжает выводиться.
  it('модуль секций сборки не выводит документы из произвольного содержимого', () => {
    const file = join(ROOT, 'web', 'scripts', 'lib', 'seminar-sections.ts');
    expect(existsSync(file), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${file}`).toBe(true);
    const code = readFileSync(file, 'utf-8');
    expect(
      /certificates/.test(code),
      'секции сборки берут «Выдаваемые документы» из поля произвольного содержимого',
    ).toBe(false);
  });
});

describe('схема CMS: выдаваемые документы описаны структурно', () => {
  it('у семинара есть поле состояния сведений из трёх значений', () => {
    const attributes = schema('seminar').attributes ?? {};
    const found = Object.entries(attributes).find(
      ([field, a]) => a.type === 'enumeration' && /document|svedeni/i.test(field),
    );
    expect(found, 'нет поля состояния сведений о документах').toBeDefined();
    const [, a] = found!;
    expect((a.enum as string[])?.length, 'состояний не три').toBe(3);
    expect(a.required ?? false, 'schema.required блокирует черновик до publication guard').toBe(false);
  });

  it('у семинара есть повторяемый набор записей о документах', () => {
    const attributes = schema('seminar').attributes ?? {};
    const found = Object.entries(attributes).find(
      ([, a]) => a.type === 'component' && a.repeatable === true,
    );
    expect(found, 'нет повторяемого набора записей о документах').toBeDefined();
  });

  it('основание перехода из неподтверждённого состояния хранит дату, источник и автора', () => {
    const attributes = schema('seminar').attributes ?? {};
    const names = Object.keys(attributes);
    expect(names.some((name) => /confirmation.*date|date.*confirmation/i.test(name))).toBe(true);
    expect(names.some((name) => /confirmation.*source|source.*confirmation/i.test(name))).toBe(true);
    expect(names.some((name) => /confirmation.*author|author.*confirmation/i.test(name))).toBe(true);
  });

  it('компонент записи о документе называет документ, выдающее лицо и структурное условие', () => {
    const dir = join(ROOT, 'cms', 'src', 'components');
    expect(existsSync(dir), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${dir}`).toBe(true);
    const files: string[] = [];
    for (const group of readdirSync(dir)) {
      const groupDir = join(dir, group);
      for (const file of readdirSync(groupDir)) if (file.endsWith('.json')) files.push(join(groupDir, file));
    }
    expect(files.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: компонентов нет вовсе').toBeGreaterThan(0);

    const candidates = files
      .map((f) => ({ f, json: JSON.parse(readFileSync(f, 'utf-8')) as Schema }))
      .filter(({ json }) => {
        const names = Object.keys(json.attributes ?? {});
        return names.some((n) => /document|issuer/i.test(n));
      });
    expect(candidates.length, 'нет компонента записи о выдаваемом документе').toBeGreaterThan(0);

    const { json } = candidates[0];
    const attributes = json.attributes ?? {};
    const names = Object.keys(attributes);
    expect(names.some((n) => /document/i.test(n)), 'запись не называет документ').toBe(true);
    expect(names.some((n) => /issuer|vydayush/i.test(n)), 'запись не называет выдающее лицо').toBe(true);

    const enums = Object.entries(attributes).filter(([, a]) => a.type === 'enumeration');
    expect(
      enums.length,
      'условие получения задано свободной строкой: контролируемого перечня нет',
    ).toBeGreaterThanOrEqual(2);
    const education = enums.find(([n]) => /education|obrazovan/i.test(n));
    const outcome = enums.find(([n]) => /outcome|result|obuchen/i.test(n));
    expect(education, 'нет перечня по исходному образованию').toBeDefined();
    expect(outcome, 'нет перечня по результату обучения').toBeDefined();
    expect((education![1].enum as string[])?.length, 'перечень образования короче четырёх значений')
      .toBeGreaterThanOrEqual(4);
    expect((outcome![1].enum as string[])?.length, 'перечень результата короче четырёх значений')
      .toBeGreaterThanOrEqual(4);
  });
});

describe('схема CMS: персона — один тип с признаком одного значения', () => {
  it('признак персоны — перечень из двух значений и не блокирует черновик', () => {
    const attributes = schema(PERSON).attributes ?? {};
    const found = Object.entries(attributes).find(
      ([, a]) => a.type === 'enumeration' && Array.isArray(a.enum) && (a.enum as string[]).length === 2,
    );
    expect(found, 'у персоны нет признака из двух значений').toBeDefined();
    expect(found![1].required ?? false, 'признак блокирует неполный черновик до publication guard').toBe(false);
  });

  it('отдельного типа для авторов методик нет', () => {
    const names = ALL.map((s) => s.name);
    expect(
      names.filter((n) => /method[-_]?author|avtor/i.test(n)),
      'авторы методик остались отдельным типом — каталог раздвоится',
    ).toEqual([]);
  });

  it('у персоны есть связь с институтом, и она не обязательна', () => {
    const attributes = schema(PERSON).attributes ?? {};
    const relation = Object.entries(attributes).find(
      ([, a]) => a.type === 'relation' && String(a.target ?? '').includes('institute'),
    );
    expect(relation, 'нет связи персоны с институтом — состав института выводить нечем').toBeDefined();
    expect(
      relation![1].required ?? false,
      'связь с институтом объявлена обязательной: персона без института не публикуется',
    ).toBe(false);
  });
});

describe('схема CMS: категория статьи — программа с поднятым признаком', () => {
  it('у программы есть признак «является категорией статей» со значением по умолчанию «да»', () => {
    const attributes = schema('course-group').attributes ?? {};
    const found = Object.entries(attributes).find(
      ([field, a]) => a.type === 'boolean' && /categor/i.test(field),
    );
    expect(found, 'у программы нет признака категории статей').toBeDefined();
    // Scenario: новая программа по умолчанию является категорией
    expect(found![1].default, 'признак по умолчанию не поднят').toBe(true);
  });

  it('отдельного справочника категорий нет', () => {
    expect(
      ALL.map((s) => s.name).filter((n) => /^(article-)?categor/i.test(n)),
      'справочник категорий стал вторым источником истины о том же перечне',
    ).toEqual([]);
  });

  it('у статьи есть связь с программами-категориями', () => {
    const attributes = schema('article').attributes ?? {};
    const relation = Object.entries(attributes).find(
      ([field, a]) =>
        a.type === 'relation' &&
        String(a.target ?? '').includes('course-group') &&
        /categor/i.test(field),
    );
    expect(relation, 'у статьи нет связи с программами как категориями').toBeDefined();
  });
});

describe('схема CMS: обязательные поля публикации', () => {
  const requiredNames = (name: string): string[] =>
    Object.entries(schema(name).attributes ?? {})
      .filter(([, a]) => a.required === true)
      .map(([field]) => field);

  it.each([
    ['article', ['title', 'slug', 'body']],
    ['seminar', ['name', 'slug', 'description']],
    ['course-group', ['name', 'slug', 'description']],
    ['institute', ['name', 'slug', 'description']],
    ['page', ['title', 'slug', 'body']],
    ['video-playlist', ['name', 'slug']],
    ['news-item', ['name', 'date', 'description']],
    ['promotion', ['name', 'date', 'description']],
    ['schedule-entry', ['seminar', 'startAt', 'endAt', 'city', 'eventStatus']],
  ])('у типа %s существуют поля публикационного контракта', (name, expected) => {
    const attributes = schema(name).attributes ?? {};
    for (const field of expected as string[]) {
      expect(attributes, `${name}.${field} отсутствует в схеме`).toHaveProperty(field);
    }
  });

  it('обязательность не блокирует сохранение неполного черновика на уровне схемы', () => {
    for (const { name } of ALL) {
      if (schema(name).options?.draftAndPublish !== true) continue;
      expect(requiredNames(name), `${name}: schema.required блокирует неполный черновик до publication guard`).toEqual(
        [],
      );
    }
  });

  // Незаполненные заголовок и описание страницы не видны редактору визуально и дают
  // страницу без заголовка в выдаче — поэтому их проверяет publication guard. На уровне
  // компонента required запрещал бы сохранить черновик с частично заполненным SEO.
  it('компонент SEO не блокирует неполный черновик до publication guard', () => {
    const file = join(ROOT, 'cms', 'src', 'components', 'shared', 'seo.json');
    expect(existsSync(file), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${file}`).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf-8')) as Schema;
    for (const field of ['seo_title', 'seo_description']) {
      expect(json.attributes?.[field]?.required ?? false, `${field} блокирует неполный черновик`).toBe(false);
    }
  });

  it.each(['article', 'seminar', 'course-group', 'institute', 'page'])(
    'компонент SEO у типа %s не блокирует неполный черновик',
    (name) => {
      const seo = attr(name, 'seo');
      expect(seo, `у ${name} нет компонента SEO`).toBeDefined();
      expect(seo!.required ?? false, `компонент SEO у ${name} блокирует неполный черновик`).toBe(false);
    },
  );

  it('легаси-поля не обязательны ни у одного типа', () => {
    for (const { name } of ALL) {
      for (const [field, a] of Object.entries(schema(name).attributes ?? {})) {
        if (/^legacy_/.test(field)) {
          expect(a.required ?? false, `${name}.${field} обязательно: новая запись не публикуется`).toBe(
            false,
          );
        }
      }
    }
  });
});

describe('схема CMS: событие расписания приведено к составу данных', () => {
  // D1/G5: связь на преподавателей вместо json; G6: цена и длительность только у события.
  it('состояние события не конфликтует с системным параметром Draft & Publish status', () => {
    const attributes = schema('schedule-entry').attributes ?? {};
    expect(attributes, 'пользовательское поле status конфликтует с Document Service').not.toHaveProperty('status');
    expect(attributes, 'у события нет отдельного поля состояния').toHaveProperty('eventStatus');
  });

  it('преподаватели события — связь, а не json', () => {
    const teachers = attr('schedule-entry', 'teachers');
    expect(teachers, 'нет поля преподавателей у события').toBeDefined();
    expect(teachers!.type, 'преподаватели события остались json').toBe('relation');
  });

  it('цена и длительность не продублированы у семинара', () => {
    const attributes = schema('seminar').attributes ?? {};
    expect(Object.keys(attributes), 'цена продублирована у семинара').not.toContain('price');
    expect(Object.keys(attributes), 'длительность продублирована у семинара').not.toContain('duration');
  });
});

describe('схема CMS: состав института задаётся связью с персоной', () => {
  it('связь с институтами необязательна, легаси-поля состава нет', () => {
    const attributes = schema(PERSON).attributes ?? {};
    const institutes = attributes.institutes;

    expect(institutes, 'у персоны нет связи с институтами').toMatchObject({
      type: 'relation',
      relation: 'manyToMany',
      target: 'api::institute.institute',
    });
    expect(institutes, 'связь с институтом блокирует публикацию персоны без института').not.toHaveProperty(
      'required',
      true,
    );
    expect(attributes, 'состав института всё ещё хранится в легаси-поле').not.toHaveProperty(
      'institute_legacy_id',
    );
  });
});

describe('схема CMS: история адресов', () => {
  // Requirement: Смена адреса опубликованной записи оставляет постоянное перенаправление.
  // Файловая часть требования «история не редактируется ролями»: тип существует и не
  // показывается в менеджере контента. Отказ живого интерфейса — ручное свидетельство.
  it('тип истории адресов существует', () => {
    const found = ALL.find((s) => /address[-_]?history|istoriya[-_]?adres/i.test(s.name));
    expect(found, 'типа истории адресов нет — перенаправления выводить неоткуда').toBeDefined();
  });

  it('история адресов не редактируется через менеджер контента', () => {
    const found = ALL.find((s) => /address[-_]?history|istoriya[-_]?adres/i.test(s.name));
    expect(found, 'типа истории адресов нет').toBeDefined();
    const json = JSON.parse(readFileSync(found!.path, 'utf-8')) as Schema;
    const contentManager = (json.pluginOptions?.['content-manager'] ?? {}) as { visible?: boolean };
    expect(
      contentManager.visible,
      'история адресов доступна прямому редактированию через менеджер контента',
    ).toBe(false);
  });

  it('история адресов не имеет публичного CRUD API', () => {
    const route = join(ROOT, 'cms', 'src', 'api', 'address-history', 'routes', 'address-history.ts');
    expect(existsSync(route), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${route}`).toBe(true);
    const source = readFileSync(route, 'utf-8');
    expect(source, 'core router открывает прямое создание, правку и удаление истории').not.toMatch(
      /createCoreRouter/,
    );
    expect(source, 'маршруты истории должны быть пустыми: пишет только внутренний lifecycle').toMatch(
      /routes\s*:\s*\[\s*\]/,
    );
  });

  it('история адресов всегда называет тип владельца для вычисления текущей цели', () => {
    expect(schema('address-history').attributes?.owner_type?.required).toBe(true);
  });

  it('запись истории называет адрес и владельца', () => {
    const found = ALL.find((s) => /address[-_]?history|istoriya[-_]?adres/i.test(s.name));
    expect(found).toBeDefined();
    const json = JSON.parse(readFileSync(found!.path, 'utf-8')) as Schema;
    const names = Object.keys(json.attributes ?? {});
    expect(names.some((n) => /address|adres|url|path/i.test(n)), 'нет поля адреса').toBe(true);
    expect(
      names.some((n) => /owner|record|vladelec/i.test(n)),
      'нет владельца адреса — после удаления записи гарантия исчезнет',
    ).toBe(true);
  });
});

describe('схема CMS: имена полей не сталкиваются с системными колонками Strapi', () => {
  it('дата материала статьи не объявляет второй published_at поверх Draft & Publish', () => {
    expect(attr('article', 'published_at')).toBeUndefined();
    expect(attr('article', 'publication_date')?.type).toBe('datetime');
  });
});

/*
 * СЦЕНАРИИ, КОТОРЫЕ СХЕМОЙ НЕ ПРОВЕРЯЮТСЯ
 *
 * Схема — носитель контракта, а не поведения. Отказ админки на публикации, права ролей
 * и предупреждение редактора живут в развёрнутом Strapi, которого нет ни в репозитории,
 * ни в CI. Поведенческая часть тех же требований проверена чисто в
 * `scripts/lib/cms-publication-validation.test.ts`; отказ живого интерфейса — ручная
 * проверка со свидетельством после развёртывания.
 */
