/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`,
 * capability `cms-content-authoring`: признак персоны, состав института, обязательная
 * категория статьи, обязательные поля публикации, структурные сведения о выдаваемых
 * документах.
 *
 * Реализации нет — модуль `./cms-publication-validation.ts` подгружается динамически.
 *
 * Каждая проверка «принято» стоит рядом с парной проверкой «отклонено» по тому же
 * предмету: без пары первая проходит и на реализации, которая не проверяет ничего.
 */

import { describe, expect, it } from 'vitest';
import {
  loadContentValidation,
  type DocumentRecord,
  type SeminarDocuments,
} from './cms-authoring-contract';

const doc = (over: Partial<DocumentRecord> = {}): DocumentRecord => ({
  document: 'Удостоверение о повышении квалификации',
  issuer: 'ЧУ ДПО «Институт кинезиологии»',
  priorEducation: 'medical',
  ...over,
});

const seminar = (over: Partial<SeminarDocuments> = {}): SeminarDocuments => ({
  identifier: 'cst-1',
  documentsState: 'issued',
  documents: [doc()],
  ...over,
});

describe('cms-content-authoring: признак персоны', () => {
  // Scenario: персона без признака не публикуется
  it('публикация персоны без признака отклоняется с указанием поля', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({ type: 'person', record: { name: 'Иванов', identifier: 'ivanov' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('trait');
  });

  it('персона с признаком публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'person',
      record: { name: 'Иванов', identifier: 'ivanov', trait: 'teacher' },
    });
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it('признак принимает ровно одно значение из двух', async () => {
    const { checkPublication } = await loadContentValidation();
    expect(
      checkPublication({
        type: 'person',
        record: { name: 'И', identifier: 'i', trait: ['teacher', 'method-author'] },
      }).ok,
      'признак нескольких значений принят — признак стал множественным',
    ).toBe(false);
    expect(
      checkPublication({ type: 'person', record: { name: 'И', identifier: 'i', trait: 'lecturer' } }).ok,
      'принято значение вне двух допустимых',
    ).toBe(false);
  });

  // Scenario: в сведениях об организации только преподаватели
  it('в состав педагогических работников попадают только преподаватели', async () => {
    const { pedagogicalStaff } = await loadContentValidation();
    const staff = pedagogicalStaff([
      { id: 'p1', trait: 'teacher' },
      { id: 'p2', trait: 'method-author' },
      { id: 'p3', trait: 'teacher' },
    ]);
    expect(staff.sort()).toEqual(['p1', 'p3']);
    expect(staff, 'автор методики попал в состав педагогических работников').not.toContain('p2');
  });
});

describe('cms-content-authoring: связь персоны с институтом', () => {
  // Scenario: новая персона без легаси-поля попадает в состав института
  it('состав института выводится из связи, а не из легаси-поля', async () => {
    const { instituteMembers } = await loadContentValidation();
    const members = instituteMembers({
      instituteId: 'institut-apledzhera',
      persons: [
        { id: 'new', trait: 'teacher', instituteIds: ['institut-apledzhera'] },
        { id: 'legacy-only', trait: 'teacher', instituteIds: [], legacyInstitute: 'institut-apledzhera' },
      ],
    });
    expect(members, 'новая персона со связью не попала в состав').toContain('new');
    expect(
      members,
      'состав всё ещё выводится сопоставлением легаси-поля: запись без связи попала в институт',
    ).not.toContain('legacy-only');
  });

  // Scenario: персона без института публикуется
  it('персона без связи публикуется и ни в один состав не попадает', async () => {
    const { checkPublication, instituteMembers, requiredFields } = await loadContentValidation();
    expect(requiredFields('person'), 'связь с институтом объявлена обязательной').not.toContain(
      'institutes',
    );
    expect(
      checkPublication({ type: 'person', record: { name: 'И', identifier: 'i', trait: 'teacher' } }).ok,
    ).toBe(true);
    expect(
      instituteMembers({
        instituteId: 'institut-apledzhera',
        persons: [{ id: 'i', trait: 'teacher', instituteIds: [] }],
      }),
    ).toEqual([]);
  });
});

describe('cms-content-authoring: обязательная категория статьи', () => {
  // Scenario: публикация статьи без категории отклоняется
  it('статья без категории не публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'article',
      record: {
        title: 'Т',
        identifier: 't',
        body: '<p>т</p>',
        seo_title: 'Т',
        seo_description: 'о',
        image: 'a.jpg',
        published_at: '2026-01-01',
        categories: [],
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('categories');
  });

  // Scenario: у статьи несколько категорий
  it('две категории принимаются, и статья относится к обеим', async () => {
    const { checkPublication } = await loadContentValidation();
    const record = {
      title: 'Т',
      identifier: 't',
      body: '<p>т</p>',
      seo_title: 'Т',
      seo_description: 'о',
      image: 'a.jpg',
      published_at: '2026-01-01',
      categories: ['dolgoletie', 'prikladnaya-kineziologiya'],
    };
    const verdict = checkPublication({ type: 'article', record });
    expect(verdict.ok, verdict.message).toBe(true);
    expect(record.categories).toHaveLength(2);
  });

  // Scenario: снятие признака у единственной категории статьи отклоняется
  it('снятие признака у единственной категории отклоняется и называет статьи', async () => {
    const { checkCategoryFlagRemoval } = await loadContentValidation();
    const verdict = checkCategoryFlagRemoval({
      programIdentifier: 'dolgoletie',
      articles: [
        { identifier: 'a1', categories: ['dolgoletie'], published: true },
        { identifier: 'a2', categories: ['dolgoletie', 'prikladnaya-kineziologiya'], published: true },
        { identifier: 'a3', categories: ['dolgoletie'], published: false },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockingArticles).toEqual(['a1']);
  });

  it('снятие признака у программы, не бывшей единственной категорией, принимается', async () => {
    const { checkCategoryFlagRemoval } = await loadContentValidation();
    const verdict = checkCategoryFlagRemoval({
      programIdentifier: 'dolgoletie',
      articles: [{ identifier: 'a2', categories: ['dolgoletie', 'other'], published: true }],
    });
    expect(verdict.ok, verdict.message).toBe(true);
    expect(verdict.blockingArticles).toEqual([]);
  });
});

describe('cms-content-authoring: обязательные поля публикации', () => {
  // Scenario: публикация без описания страницы отклонена
  it('статья с пустым описанием страницы не публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'article',
      record: {
        title: 'Т',
        identifier: 't',
        body: '<p>т</p>',
        seo_title: 'Т',
        seo_description: '',
        image: 'a.jpg',
        published_at: '2026-01-01',
        categories: ['dolgoletie'],
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('seo_description');
  });

  // Scenario: публикация события без города отклонена
  it('событие расписания без города не публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'schedule-entry',
      record: { seminar: 'cst-1', startAt: '2026-09-01', endAt: '2026-09-02', status: 'active' },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('city');
  });

  // Scenario: черновик с пустыми полями сохраняется
  it('черновик с пустыми полями сохраняется и на сайте не появляется', async () => {
    const { checkDraftSave } = await loadContentValidation();
    const result = checkDraftSave({ type: 'article', record: { title: '' } });
    expect(result.saved, 'черновик с пустыми полями отклонён — потеря введённого текста').toBe(true);
  });

  // Состав обязательных полей задан по типам, а не одним общим списком: без этого
  // «отказ обещан для любой записи» нечем проверить.
  it.each([
    ['article', ['title', 'identifier', 'body', 'seo_title', 'seo_description', 'image', 'published_at', 'categories']],
    ['seminar', ['name', 'identifier', 'course_group', 'description', 'seo_title', 'seo_description', 'documentsState']],
    ['course-group', ['name', 'identifier', 'institute', 'description', 'seo_title', 'seo_description']],
    ['institute', ['name', 'identifier', 'description', 'seo_title', 'seo_description', 'order']],
    ['person', ['name', 'identifier', 'trait']],
    ['schedule-entry', ['seminar', 'startAt', 'endAt', 'city', 'status']],
    ['static-page', ['title', 'identifier', 'body', 'seo_title', 'seo_description']],
    ['video-playlist', ['title', 'identifier']],
  ] as const)('состав обязательных полей типа %s задан', async (type, expected) => {
    const { requiredFields } = await loadContentValidation();
    const actual = requiredFields(type);
    expect(actual.length, `состав для ${type} пуст — проверять нечего`).toBeGreaterThan(0);
    for (const field of expected) expect(actual, `${type}: нет ${field}`).toContain(field);
  });

  it.each(['news-item', 'promotion'] as const)('состав обязательных полей типа %s задан', async (type) => {
    const { requiredFields } = await loadContentValidation();
    const actual = requiredFields(type);
    for (const field of ['title', 'date', 'body']) expect(actual, `${type}: нет ${field}`).toContain(field);
  });
});

describe('cms-content-authoring: выдаваемые документы описаны структурно', () => {
  // Scenario: состояние сведений не задано
  it('семинар без состояния сведений не публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'seminar',
      record: {
        name: 'C',
        identifier: 'c',
        course_group: 'p1',
        description: 'о',
        seo_title: 'C',
        seo_description: 'о',
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toContain('documentsState');
  });

  // Scenario: состояние «выдаются» без записей не публикуется
  it('состояние «выдаются» с пустым набором записей не публикуется', async () => {
    const { checkPublication } = await loadContentValidation();
    const verdict = checkPublication({
      type: 'seminar',
      record: {
        name: 'C',
        identifier: 'c',
        course_group: 'p1',
        description: 'о',
        seo_title: 'C',
        seo_description: 'о',
        documentsState: 'issued',
        documents: [],
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/документ|набор/i);
  });

  // Scenario: переход из «не подтверждено» без основания отклоняется
  it('переход из «не подтверждено» без основания отклоняется', async () => {
    const { checkDocumentsStateChange } = await loadContentValidation();
    expect(checkDocumentsStateChange({ from: 'unconfirmed', to: 'issued' }).ok).toBe(false);
    expect(checkDocumentsStateChange({ from: 'unconfirmed', to: 'not-issued' }).ok).toBe(false);
  });

  it('переход из «не подтверждено» с датой, источником и автором принимается', async () => {
    const { checkDocumentsStateChange } = await loadContentValidation();
    const verdict = checkDocumentsStateChange({
      from: 'unconfirmed',
      to: 'issued',
      confirmation: { date: '2026-09-01', source: 'письмо заказчика', author: 'admin' },
    });
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it('неполное основание переходом не считается', async () => {
    const { checkDocumentsStateChange } = await loadContentValidation();
    for (const confirmation of [
      { date: '2026-09-01', source: '', author: 'admin' },
      { date: '', source: 'письмо', author: 'admin' },
      { date: '2026-09-01', source: 'письмо', author: '' },
    ]) {
      expect(
        checkDocumentsStateChange({ from: 'unconfirmed', to: 'issued', confirmation }).ok,
        `принято неполное основание: ${JSON.stringify(confirmation)}`,
      ).toBe(false);
    }
  });

  // Кратность и соединение заданы требованием, отдельного сценария у них нет:
  // не более одного значения по каждому основанию, дизъюнкция — отдельными записями.
  it('запись набора не принимает двух значений по одному основанию', async () => {
    const { checkDocumentRecord } = await loadContentValidation();
    expect(checkDocumentRecord(doc()).ok).toBe(true);
    expect(
      checkDocumentRecord({
        ...doc(),
        priorEducation: ['medical', 'physical-or-pedagogical'] as unknown as DocumentRecord['priorEducation'],
      }).ok,
      'составное значение по основанию принято — дизъюнкция ушла в одну строку',
    ).toBe(false);
  });

  it('значение «иное» требует уточняющего текста', async () => {
    const { checkDocumentRecord } = await loadContentValidation();
    expect(checkDocumentRecord({ ...doc(), priorEducation: 'other' }).ok).toBe(false);
    expect(
      checkDocumentRecord({ ...doc(), priorEducation: 'other', priorEducationNote: 'юридическое' }).ok,
    ).toBe(true);
  });

  it('оба основания в одной записи соединяются как И', async () => {
    const { checkDocumentRecord } = await loadContentValidation();
    const verdict = checkDocumentRecord({ ...doc(), outcome: 'completed' });
    expect(verdict.ok, verdict.message).toBe(true);
  });

  it('запись без выдающего лица не принимается', async () => {
    const { checkDocumentRecord } = await loadContentValidation();
    expect(checkDocumentRecord({ ...doc(), issuer: '' }).ok).toBe(false);
  });

  // Scenario: запись соответствия называет образование, документ и выдающего
  it('каждая запись сводного соответствия называет три значения', async () => {
    const { aggregateCompliance } = await loadContentValidation();
    const { rows } = aggregateCompliance([seminar()]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.priorEducation, 'исходное образование не названо').toBeTruthy();
      expect(row.document, 'документ не назван').toBeTruthy();
      expect(row.issuer, 'выдающее лицо не названо').toBeTruthy();
    }
  });

  // Scenario: семинар с двумя документами на разных условиях
  it('две записи семинара дают две строки соответствия, а не одну', async () => {
    const { aggregateCompliance } = await loadContentValidation();
    const { rows } = aggregateCompliance([
      seminar({
        documents: [
          doc({ document: 'Сертификат', priorEducation: 'none' }),
          doc({ document: 'Удостоверение', priorEducation: 'medical' }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.document).sort()).toEqual(['Сертификат', 'Удостоверение']);
  });

  // Scenario: документ по результату обучения
  it('документ по непрохождению аттестации не представлен как выдаваемый всем', async () => {
    const { aggregateCompliance } = await loadContentValidation();
    const { rows } = aggregateCompliance([
      seminar({
        documents: [doc({ document: 'Справка', priorEducation: undefined, outcome: 'assessment-failed' })],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome, 'условие по результату обучения потеряно в строке').toBe('assessment-failed');
  });

  // Scenario: семинар без выдаваемых документов представлен явно
  it('состояние «не выдаются» даёт свою строку и не попадает в «уточняется»', async () => {
    const { presentationFormOf, aggregateCompliance } = await loadContentValidation();
    const s = seminar({ identifier: 'bez-dokumentov', documentsState: 'not-issued', documents: [] });
    expect(presentationFormOf(s)).toBe('not-issued-row');
    const result = aggregateCompliance([s]);
    expect(result.notIssued).toEqual(['bez-dokumentov']);
    expect(result.unconfirmed).not.toContain('bez-dokumentov');
    expect(result.rows.map((r) => r.seminar)).not.toContain('bez-dokumentov');
  });

  // Scenario: неподтверждённые сведения перечислены отдельно
  it('состояние «не подтверждено» даёт элемент списка и не даёт строки', async () => {
    const { presentationFormOf, aggregateCompliance } = await loadContentValidation();
    const s = seminar({ identifier: 'neizvestno', documentsState: 'unconfirmed', documents: [] });
    expect(presentationFormOf(s)).toBe('unconfirmed-list');
    const result = aggregateCompliance([s]);
    expect(result.unconfirmed).toEqual(['neizvestno']);
    expect(result.rows.map((r) => r.seminar)).not.toContain('neizvestno');
    expect(result.notIssued).not.toContain('neizvestno');
  });

  // Scenario: каждый семинар попадает ровно в одну форму
  // Scenario: охват полон  (второй сценарий дословно совпадает с первым — см. дефект D3)
  it('каждый семинар представлен ровно одной из трёх форм', async () => {
    const { aggregateCompliance } = await loadContentValidation();
    const seminars = [
      seminar({ identifier: 's-issued' }),
      seminar({ identifier: 's-not-issued', documentsState: 'not-issued', documents: [] }),
      seminar({ identifier: 's-unconfirmed', documentsState: 'unconfirmed', documents: [] }),
    ];
    const result = aggregateCompliance(seminars);
    const appearances = new Map<string, number>();
    for (const id of [
      ...result.rows.map((r) => r.seminar),
      ...result.notIssued,
      ...result.unconfirmed,
    ]) {
      appearances.set(id, (appearances.get(id) ?? 0) + 1);
    }
    for (const s of seminars) {
      expect(appearances.get(s.identifier), `${s.identifier} представлен не одной формой`).toBe(1);
    }
  });

  // Scenario: сводное соответствие согласовано со страницей семинара
  it('сводное соответствие по программе — агрегация записей её семинаров, а не отдельный набор', async () => {
    const { aggregateCompliance } = await loadContentValidation();
    const one = seminar({ identifier: 'a', documents: [doc({ document: 'Сертификат' })] });
    const two = seminar({ identifier: 'b', documents: [doc({ document: 'Удостоверение' })] });
    const program = aggregateCompliance([one, two]);
    for (const s of [one, two]) {
      const own = aggregateCompliance([s]).rows;
      const fromProgram = program.rows.filter((r) => r.seminar === s.identifier);
      expect(fromProgram, `обещание программы расходится со страницей семинара ${s.identifier}`).toEqual(
        own,
      );
    }
  });
});

/*
 * СЦЕНАРИИ ЭТИХ ТРЕБОВАНИЙ БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * - «смена признака не меняет адреса» — адрес по построению есть функция типа и
 *   идентификатора (`addressOf` признака в аргументах не имеет), см.
 *   `cms-content-address.test.ts`; наблюдаемая часть «перенаправления не появилось»
 *   проверяется там же через `redirectsFor`.
 * - «каталог специалистов показывает обе группы и называет группу каждой персоны» —
 *   предмет собранной страницы `/specialisty`, см. `web/tests/cms-catalog-pages.test.ts`.
 * - «редактор правит контент» и «редактор не управляет доступом и структурой» — права
 *   в развёрнутом Strapi; в репозитории их носителя нет. Ручная проверка после
 *   развёртывания со свидетельством (адрес, пользователь, отказ интерфейса).
 */
