import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Тесты по спеке change `external-widgets` — ЧУЖИЕ ИНВАРИАНТЫ, которые change ломает
 * молча, и реестры, в которых новые проверки обязаны быть объявлены.
 *
 * Предмет — файлы репозитория: закоммиченные фикстуры реестра исполняемого вывода и
 * конфигурации прогонов. Ни один каталог вывода этот файл не читает.
 *
 * ── ПОЧЕМУ ЗДЕСЬ НЕТ ЛИТЕРАЛОВ С ИМЕНАМИ КОРНЕЙ СБОРКИ ──────────────────────
 * Инвариант `web/tests/demo-gate.test.ts:670` определяет ПРЕДМЕТ файла по строковым
 * литералам в его импортном замыкании: литерал, кончающийся на имя корня вывода, делает
 * файл читателем этого вывода. Реестр хранит оба корня В ДАННЫХ, и если сравнивать их с
 * именами, написанными здесь, файл получил бы два предмета — то есть был бы недопустим
 * по спеке этого же change. Поэтому корни проверяются по СОСТАВУ реестра (сколько их и
 * различны ли), а не сверкой с именами.
 */

const WEB = join(import.meta.dirname, '..');
const FIXTURES = join(WEB, 'tests', 'fixtures', 'rich-content-safety');

interface Registry {
  status?: string;
  ciMustNotRegenerate?: boolean;
  slotIds: string[];
  distRoots?: string[];
  occurrences: { slotId: string; route: string; placement: string; identity: string; count: number }[];
}

interface Slot {
  slotId: string;
  file: string;
  nodeKind: string;
  identity: string;
}

const registry = (): Registry =>
  JSON.parse(readFileSync(join(FIXTURES, 'output-occurrence-registry.json'), 'utf-8')) as Registry;
const slots = (): Slot[] =>
  JSON.parse(readFileSync(join(FIXTURES, 'executable-source-slots.json'), 'utf-8')) as Slot[];

// ── Компоненты, которые change вносит (швы, выбранные этими тестами) ─────────
// Спека путей не задаёт. Проверке нужен предмет, поэтому пути названы здесь:
const FACADE_COMPONENT = 'components/chat/ChatFacade.astro';
const REVIEWS_COMPONENT = 'components/home/sections/Reviews.astro';
const SHARED_LAYOUT = 'layouts/BaseLayout.astro';

describe('встраивания не ломают принятый реестр исполняемого вывода', () => {
  it('реестр не остался с пустым списком вхождений', () => {
    // Сценарий «инструменты запущены в обратном порядке»: генератор инвентаря слотов
    // записывает реестр с ПУСТЫМ списком вхождений
    // (`web/tests/helpers/rich-content-safety/generate-baseline.ts:118`,
    // `occurrences: [] as { slotId: string;`), поэтому запуск после генератора вхождений
    // стирает их все. Состояние недопустимо, и это ЕДИНСТВЕННЫЙ его наблюдаемый признак.
    const reg = registry();
    expect(
      reg.occurrences.length,
      'реестр вывода пуст: похоже, генератор инвентаря слотов запущен ПОСЛЕ генератора ' +
        'вхождений. Порядок обязателен: сначала инвентарь, затем вхождения',
    ).toBeGreaterThan(0);
    expect(reg.slotIds.length, 'инвентарь слотов в реестре пуст').toBeGreaterThan(0);
  });

  it('реестр собран при ОБОИХ собранных деревьях', () => {
    // При одном собранном дереве инструмент пишет усечённый реестр и не отказывается:
    // падает потом сверка по второму выводу, по причине, не похожей на настоящую.
    const roots = registry().distRoots ?? [];
    expect(roots.length, 'в реестре не записано ни одного корня сборки').toBeGreaterThan(0);
    expect(
      new Set(roots).size,
      `корней сборки в реестре ${new Set(roots).size}, а требуется два различных: реестр, ` +
        'снятый с одного дерева, усечён',
    ).toBe(2);
    for (const root of roots)
      expect(
        root.startsWith('/') || /^[A-Za-z]:/.test(root),
        `корень '${root}' записан абсолютным путём — это путь чужой машины, а не репозитория`,
      ).toBe(false);
  });

  it('реестр помечен как снятый на отревьюированной ревизии и запрещённый к перегенерации в CI', () => {
    const reg = registry();
    expect(reg.ciMustNotRegenerate, 'реестр не запрещает перегенерацию в CI').toBe(true);
    expect(
      reg.status,
      'реестр не помечен как снятый по собранному выводу: значит вхождения не сверены ' +
        'ни с одним деревом',
    ).not.toBe('source-inventory-only');
  });

  it('вставка компонента в общий layout переписала инвентарь слотов', () => {
    // Непустота предмета: пока компонента нет, утверждать нечего, и проверка обязана
    // считаться непройденной, а не пройденной.
    expect(
      existsSync(join(WEB, 'src', FACADE_COMPONENT)),
      `компонента '${FACADE_COMPONENT}' нет — предмета нет. Это «проверить не удалось»`,
    ).toBe(true);
    expect(existsSync(join(WEB, 'src', REVIEWS_COMPONENT)), `нет '${REVIEWS_COMPONENT}'`).toBe(true);

    const inLayout = readFileSync(join(WEB, 'src', SHARED_LAYOUT), 'utf-8');
    expect(
      inLayout.includes('ChatFacade'),
      'фасад чата не подключён в общем layout — «на всех страницах» не выполнено',
    ).toBe(true);

    const files = new Set(slots().map((s) => s.file));
    expect(
      files.has(FACADE_COMPONENT),
      `в инвентаре слотов нет ни одного слота из '${FACADE_COMPONENT}': инвентарь не ` +
        'перегенерирован, и сверка исполняемого вывода упадёт в обязательном прогоне',
    ).toBe(true);
  });

  it('исполняемые узлы фасада дали вхождения на каждом маршруте, кроме 404', () => {
    // Порядок величины назван спекой: один `svg` в общем компоненте шапки даёт 574
    // правила при 4702 вхождениях на 287 маршрутов. Проверяется не число, а ПОКРЫТИЕ:
    // узел общего layout обязан иметь вхождение на каждом маршруте реестра.
    //
    // 404 — единственное объявленное исключение (spec.md: «Страница 404 из этого
    // исключена, и причина измерена своей сборкой»), и оно же — отдельный сценарий
    // ниже («на маршруте 404 вхождений со слотом фасада нет»). Требовать здесь
    // присутствия ФАСАДА и на 404 тоже значило бы противоречить тому сценарию для
    // одного и того же слота одновременно: у фасада ровно один слот
    // (`ChatFacade.astro:L31:C1:script`), и он не может одновременно быть на всех
    // маршрутах и отсутствовать на одном из них. Универсальность проверяется по
    // остальным 286 маршрутам, 404 — отдельно и намеренно противоположным сценарием.
    const reg = registry();
    const routes = new Set(reg.occurrences.map((o) => o.route).filter((r) => !/(^|\/)404(\.html)?$/.test(r)));
    expect(routes.size, 'в реестре нет ни одного маршрута').toBeGreaterThan(0);

    const facadeSlots = slots()
      .filter((s) => s.file === FACADE_COMPONENT)
      .map((s) => s.slotId);
    expect(
      facadeSlots.length,
      `в инвентаре нет слотов фасада '${FACADE_COMPONENT}' — покрытие проверять нечем`,
    ).toBeGreaterThan(0);

    const covered = new Map<string, Set<string>>();
    for (const occ of reg.occurrences) {
      if (!facadeSlots.includes(occ.slotId)) continue;
      const set = covered.get(occ.slotId) ?? new Set<string>();
      set.add(occ.route);
      covered.set(occ.slotId, set);
    }
    const gaps = facadeSlots
      .map((slotId) => ({ slotId, missing: [...routes].filter((r) => !(covered.get(slotId)?.has(r) ?? false)) }))
      .filter((x) => x.missing.length > 0)
      .map((x) => `${x.slotId}: нет вхождений на ${x.missing.length} маршрутах`);
    expect(gaps, gaps.join('\n')).toEqual([]);
  });

  it('на маршруте 404 вхождений со слотом фасада нет', () => {
    // Исключения из РЕНДЕРА недостаточно: компонентный `<style>` попадает в инлайновый
    // CSS страницы независимо от условного рендера, и реестр это показывает парой
    // «слот источника плюс маршрут». Признак механический, а не на глаз.
    const reg = registry();
    const facadeSlots = new Set(slots().filter((s) => s.file === FACADE_COMPONENT).map((s) => s.slotId));
    expect(facadeSlots.size, 'слотов фасада нет — предмета нет').toBeGreaterThan(0);
    const routes404 = reg.occurrences
      .filter((o) => facadeSlots.has(o.slotId))
      .filter((o) => /(^|\/)404(\.html)?$/.test(o.route))
      .map((o) => `${o.slotId} → ${o.route} (${o.identity})`);
    expect(
      routes404,
      'вхождение со слотом фасада есть на маршруте 404: стили компонента утекли на ' +
        'страницу, где он не отрендерен — значит они лежат в компонентном <style>',
    ).toEqual([]);
  });

  it('инвентарь слотов и реестр вывода согласованы точным равенством множеств', () => {
    // Названное совпадение с `web/tests/rich-content-baseline.test.ts:237`,
    // `slotIds реестра вывода совпадает`, а не второй независимый гейт: AGENTS.md
    // требует, чтобы две проверки над одним предметом сходились либо расхождение было
    // названо. Здесь то же утверждение проверяется потому, что ИМЕННО оно ломается от
    // вставки компонента в общий layout, и падение чужого файла читается как поломка
    // чужого.
    const inRegistry = [...registry().slotIds].sort();
    const inSlots = slots().map((s) => s.slotId).sort();
    expect(
      inRegistry.filter((id) => !inSlots.includes(id)),
      'в реестре есть слоты, которых нет в инвентаре: обновлена одна фикстура из двух',
    ).toEqual([]);
    expect(
      inSlots.filter((id) => !inRegistry.includes(id)),
      'в инвентаре есть слоты, которых нет в реестре: обновлена одна фикстура из двух',
    ).toEqual([]);
  });
});

// ─── Реестры, в которых новые проверки обязаны быть объявлены ────────────────

const NEW_OUTPUT_CHECKS = [
  'tests/external-widgets-dist.test.ts',
  'tests/external-widgets-demo.test.ts',
  'tests/external-widgets-config-probe.test.ts',
];
const NEW_BROWSER_CHECKS = [
  'external-widgets.spec.ts',
  'external-widgets-baseline-repeat.spec.ts',
  // `external-widgets-build-year.spec.ts` снят 2026-09-05 вместе с предметом: знак
  // награды выводит официальное встраивание, года в нём нет, и сравнивать две сборки
  // при разных `BUILD_YEAR` стало нечем. Проверка не исчезла, а перевернулась и
  // переехала в `external-widgets-config-probe.test.ts` — там она сравнивает разметку
  // двух сборок и требует СОВПАДЕНИЯ; браузер для этого не нужен.
];

describe('новая проверка зарегистрирована во всех реестрах, которые её требуют', () => {
  const load = async (file: string): Promise<{ include: string[]; exclude: string[] }> => {
    const abs = join(WEB, file);
    expect(existsSync(abs), `нет конфигурации ${file}`).toBe(true);
    const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
    const test = (mod.default as { test?: { include?: unknown; exclude?: unknown } })?.test;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { include: list(test?.include), exclude: list(test?.exclude) };
  };

  it('проверки по выводу сборки объявлены и в исключениях основного прогона, и в своём конфиге', async () => {
    // Оба списка проверяет и `web/tests/repo-hygiene.test.ts:308` точным равенством
    // множеств. Здесь названы ИМЕНА новых файлов: равенство множеств не скажет, что
    // потерялся именно наш, а сообщение об этом — весь смысл проверки для реализации.
    const base = await load('vitest.config.ts');
    const specialised = [
      ...(await load('vitest.build.config.ts')).include,
      ...(await load('vitest.demo.config.ts')).include,
      ...(await load('vitest.render.config.ts')).include,
    ];
    for (const file of NEW_OUTPUT_CHECKS) {
      expect(base.exclude, `${file} не исключён из основного прогона`).toContain(file);
      expect(specialised, `${file} не включён ни в одну специализированную конфигурацию`).toContain(file);
    }
  });

  it('новая браузерная проверка не объявлена долгом: она обязана исполняться гейтом', async () => {
    // «Либо в гейте, либо в долге» — ИСКЛЮЧАЮЩЕЕ «либо»: файл в обоих списках роняет
    // `web/tests/browser-test-gating.test.ts:376`, `список долга не содержит имён`.
    // Здесь закрепляется выбор: новая проверка идёт в гейт, а не в долг, — иначе она
    // зелена ровно потому, что её никто не выполняет.
    const gating = readFileSync(join(WEB, 'tests', 'browser-test-gating.test.ts'), 'utf-8');
    const debt = gating.slice(gating.indexOf('const ACKNOWLEDGED_DEBT'), gating.indexOf('];', gating.indexOf('const ACKNOWLEDGED_DEBT')));
    for (const file of NEW_BROWSER_CHECKS) {
      expect(existsSync(join(WEB, 'tests', file)), `нет файла ${file}`).toBe(true);
      expect(debt.includes(file), `${file} объявлен признанным долгом — тогда он не исполняется`).toBe(false);
    }
  });

  it('новая браузерная проверка запускается отдельным скриптом пакета', async () => {
    // Носитель вызова: гейтующий workflow запускает `npm run …`, а состав набора задаёт
    // скрипт. Без скрипта файл в гейт не попадает, и `browser-test-gating` объявит его
    // сиротой.
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    for (const file of NEW_BROWSER_CHECKS)
      expect(
        scripts.includes(file),
        `ни один скрипт пакета не запускает ${file} — в гейт публикации он не попадёт`,
      ).toBe(true);
  });

  it('ни одна новая проверка не читает оба вывода', async () => {
    // Инвариант «ровно один предмет» проверяет `web/tests/demo-gate.test.ts:670`.
    // Здесь — та же проверка, но с ИМЕНАМИ: файл, случайно получивший второй предмет,
    // назван прямо, а не выведен из общего расхождения.
    const build = (await load('vitest.build.config.ts')).include;
    const demo = (await load('vitest.demo.config.ts')).include;
    const both = NEW_OUTPUT_CHECKS.filter((f) => build.includes(f) && demo.includes(f));
    expect(both, `проверка выбрана обеими конфигурациями: ${both.join(', ')}`).toEqual([]);
  });

  it('ни одна новая браузерная проверка не стоит одновременно в гейте и в долге', () => {
    // «Либо в гейте, либо в долге» — ИСКЛЮЧАЮЩЕЕ «либо», и роняет оно с ДВУХ сторон:
    // файл вне исполняемого набора и вне списка долга — сирота
    // (`web/tests/browser-test-gating.test.ts:364`,
    // `it('каждый файл либо исполняется гейтующим workflow, либо назван в списке долга'`),
    // а файл, названный в долге и при этом исполняемый, роняет ту же проверку с другой
    // стороны (`web/tests/browser-test-gating.test.ts:376`, `список долга не содержит имён`).
    //
    // Здесь проверяется вторая сторона ПОИМЁННО: новая проверка объявлена в скрипте
    // пакета, который запускает гейтующий workflow, и одновременно её имени нет в списке
    // долга. Общее равенство множеств об этом скажет «списки разошлись», а не «потерялась
    // наша», — и лечиться это будет наугад.
    const gating = readFileSync(join(WEB, 'tests', 'browser-test-gating.test.ts'), 'utf-8');
    const start = gating.indexOf('const ACKNOWLEDGED_DEBT');
    expect(start, 'в browser-test-gating нет списка признанного долга — сверять не с чем').toBeGreaterThan(-1);
    const debt = gating.slice(start, gating.indexOf('];', start));
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');

    const problems: string[] = [];
    for (const file of NEW_BROWSER_CHECKS) {
      const inGate = scripts.includes(file);
      const inDebt = debt.includes(file);
      if (inGate && inDebt) problems.push(`${file}: и запускается скриптом пакета, и назван долгом`);
      if (!inGate && !inDebt) problems.push(`${file}: ни в одном скрипте пакета и не назван долгом`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('вызов гейта ссылок на формы с тремя аргументами не тронут', () => {
    // Он сверяется БУКВАЛЬНЫМ текстом (`web/tests/repo-hygiene.test.ts:165`,
    // `form_links_match_mode`) и служит якорем проверки порядка вызовов, то есть
    // четвёртый аргумент ронял бы обязательный прогон ДВАЖДЫ по причине, не связанной с
    // предметом новой работы. Спека выбрала путь, который тела вызова не меняет, —
    // проверка держит этот выбор.
    const deploy = readFileSync(join(WEB, '..', 'scripts', 'deploy-web.sh'), 'utf-8');
    const calls = [...deploy.matchAll(/form_links_match_mode[^\n]*/g)].map((m) => m[0]);
    expect(calls.length, 'вызова form_links_match_mode в скрипте выкладки нет').toBeGreaterThan(0);
    const withFour = calls.filter((call) => (call.match(/"\$?\{?[A-Za-z_]/g) ?? []).length > 3);
    expect(withFour, `у вызова появился четвёртый аргумент: ${withFour.join('\n')}`).toEqual([]);
  });
});
