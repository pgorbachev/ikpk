import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import {
  DEFAULT_BRANCH,
  REPO_ROOT,
  conditionsGuarding,
  loadWorkflows,
  publishingWorkflows,
  pushContext,
  workflowRunTrigger,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from './helpers/workflows';
import { canBeTrue } from './helpers/gh-expression';

// Проверки по требованию «Проверки демо-режима входят в обязательный прогон»
// (`openspec/changes/deploy-gated-on-tests/specs/deploy-gating/spec.md`) и решению 6
// в `design.md`.
//
// Предмет требования — ПОЛОЖЕНИЕ проверок, а не их описание: гейтом является ровно то,
// что лежит внутри обязательного прогона. Поэтому обязательный прогон здесь не назван
// строкой, а выводится из самого гейта публикации: публикующий workflow →
// `workflow_run.workflows` → workflow, чей успех является условием публикации. Так
// перенос демо-проверок в соседний workflow роняет проверку, даже если перечень
// входящих в гейт при этом остаётся правдивым.
//
// Второе: «два вывода — два предмета». Проверяется не текст проверок, а то, КАКОЙ
// каталог каждая из них читает, и то, что демо-сборка не пишет в боевой каталог.
//
// Третье: предмет, которого нет, — это «не выполнено». Проверяется вызовом: функция,
// через которую демо-проверки получают свой предмет, обязана падать на пустом каталоге.

/** Корень пакета web: и сборки, и конфигурации vitest, и тесты живут здесь. */
const WEB = join(REPO_ROOT, 'web');
const TESTS_DIR = join(WEB, 'tests');

/**
 * Каталоги вывода. Оба имени нормативны — взяты из утверждённого change
 * (`design.md`, решение 6: «отдельный каталог вывода демо (`dist-demo`)»; `tasks.md`,
 * задача 6.1), а не угаданы по коду. Развод предметов — часть требования, поэтому
 * другое имя каталога — отклонение от change, а не деталь реализации.
 */
const PROD_DIST = 'dist';
const DEMO_DIST = 'dist-demo';

/**
 * Переключатель демо-режима сборки. Признак взят из кода, который его читает
 * (`web/src/lib/forms.ts`, `web/src/lib/variants.ts`, `web/src/pages/preview/…`):
 * именно от него зависит, появятся ли в выводе демо-страницы. Сборка в другой каталог
 * БЕЗ этого переключателя — второй боевой вывод, а не демо-вывод, и демо-проверки
 * прошли бы по нему мимо своего предмета.
 */
const DEMO_SWITCH = 'DEMO_FORMS';

/**
 * Сам этот файл предметом не является: он называет оба каталога, чтобы про них
 * говорить. Исключение — по self-ссылке, а не по списку имён: список отстал бы молча.
 */
const SELF = relative(WEB, import.meta.filename).replaceAll('\\', '/');

const workflows = loadWorkflows();

// ─── обязательный прогон: выводится из гейта публикации ─────────────────────

function publishingWorkflow(): Workflow {
  const found = publishingWorkflows(workflows);
  if (found.length !== 1)
    throw new Error(
      `ожидался ровно один workflow с шагом actions/deploy-pages, найдено ${found.length}: ` +
        `${found.map((w) => w.file).join(', ') || '—'}`,
    );
  return found[0];
}

/** Имена workflow, успех которых является условием публикации. */
function gatedNames(): string[] {
  return workflowRunTrigger(publishingWorkflow())?.workflows ?? [];
}

/** Сами workflow обязательного прогона. Названное, но отсутствующее имя — провал. */
function gatedWorkflows(): Workflow[] {
  return gatedNames().map((name) => {
    const wf = workflows.filter((w) => w.displayName === name);
    if (wf.length !== 1)
      throw new Error(
        `в гейте назван workflow '${name}', а файлов с таким именем ${wf.length}` +
          (wf.length > 1 ? `: ${wf.map((w) => w.file).join(', ')}` : ''),
      );
    return wf[0];
  });
}

/** Workflow, которые в гейт НЕ входят: их падение публикацию не останавливает. */
function nonGatedWorkflows(): Workflow[] {
  const gated = new Set(gatedWorkflows().map((w) => w.file));
  return workflows.filter((w) => !gated.has(w.file));
}

// ─── команды шагов: раскрытие npm-скриптов ─────────────────────────────────

const webScripts: Record<string, string> = (() => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
})();

/**
 * Раскрывает `npm test` и `npm run <имя>` в тело скрипта, рекурсивно и вместе с
 * хуками `pre`/`post` (npm запускает их сам). Без раскрытия шаг `run: npm test`
 * ничего не сообщает о том, что он запускает и по какому каталогу.
 *
 * Скрипты берутся из `web/package.json`: демо-сборка и её проверки живут в пакете
 * `web`. Шаг другого пакета (`scripts/`) раскроется не своими скриптами, но ни
 * переключателя демо-режима, ни каталога демо-вывода в его тексте от этого не
 * появится — на выводы проверок это не влияет.
 */
function expandNpm(cmd: string, seen: ReadonlySet<string> = new Set()): string {
  return cmd.replace(/\bnpm\s+(?:run\s+)?([A-Za-z][\w:.-]*)/g, (whole, name: string) => {
    if (seen.has(name)) return whole;
    const chain = [`pre${name}`, name, `post${name}`].filter((n) => webScripts[n] !== undefined);
    if (chain.length === 0) return whole;
    const next = new Set(seen).add(name);
    return `${whole} :: ${chain.map((n) => expandNpm(webScripts[n], next)).join(' && ')}`;
  });
}

/** Полный текст шага: сам `run` плюс раскрытые npm-скрипты. */
function stepCommand(step: WorkflowStep): string {
  return step.run === undefined ? '' : expandNpm(step.run);
}

/** Отдельные команды внутри текста: `&&`, `||`, `;`, перевод строки, метка раскрытия. */
function commandChunks(text: string): string[] {
  return text.split(/&&|\|\||;|::|\n/);
}

/** Каталог как путь, а не как слово: `dist` не совпадает с `dist-demo`. */
function mentionsDir(text: string, dir: string): boolean {
  return new RegExp(`(?<![\\w-])${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
}

/** Сборка сайта: любой вызов сборщика, а не конкретное имя npm-скрипта. */
function isSiteBuild(text: string): boolean {
  return /\bastro\s+build\b/.test(text);
}

/** Шаг собирает сайт в демо-режиме. */
function isDemoBuildStep(step: WorkflowStep): boolean {
  const text = stepCommand(step);
  return isSiteBuild(text) && text.includes(DEMO_SWITCH);
}

/** Конфигурации vitest, которые запускает текст команды (без `--config` — основная). */
function vitestConfigsIn(text: string): string[] {
  const out = new Set<string>();
  for (const chunk of commandChunks(text)) {
    if (!/\bvitest\b/.test(chunk)) continue;
    const m = /--config[=\s]+(\S+)/.exec(chunk);
    out.add(m ? m[1] : 'vitest.config.ts');
  }
  return [...out];
}

// ─── какие файлы выбирает конфигурация vitest ──────────────────────────────

interface Selection {
  include: string[];
  exclude: string[];
}

async function configSelection(configFile: string): Promise<Selection> {
  const abs = join(WEB, configFile);
  if (!existsSync(abs)) throw new Error(`конфигурация vitest '${configFile}' не найдена`);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  const cfg = mod.default;
  if (cfg === null || typeof cfg !== 'object')
    throw new Error(`'${configFile}' не отдаёт объект конфигурации`);
  const test = (cfg as { test?: unknown }).test;
  if (test === null || typeof test !== 'object')
    throw new Error(`в '${configFile}' нет секции test — набор файлов не определён`);
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    include: asList((test as { include?: unknown }).include),
    exclude: asList((test as { exclude?: unknown }).exclude),
  };
}

/** Glob → регулярное выражение. `**` — любое число сегментов, в том числе ноль. */
function globToRegExp(pattern: string): RegExp {
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = pattern
    .split('/')
    .map((seg) => (seg === '**' ? '(?:[^/]+/)*' : `${esc(seg).replace(/\*/g, '[^/]*')}/`))
    .join('')
    .replace(/\/$/, '');
  return new RegExp(`^${body}$`);
}

/** Все файлы под web/tests — путями относительно web, как в include-шаблонах. */
function allTestTreeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(WEB, full).replaceAll('\\', '/'));
    }
  };
  walk(TESTS_DIR);
  return out.sort();
}

const testTreeFiles = allTestTreeFiles();

function selectedFiles(sel: Selection): string[] {
  const inc = sel.include.map(globToRegExp);
  const exc = sel.exclude.map(globToRegExp);
  return testTreeFiles.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}

// ─── предмет проверки: какой каталог она читает ────────────────────────────

function sourceOf(fileRelWeb: string): string {
  return readFileSync(join(WEB, fileRelWeb), 'utf-8');
}

/** Все строковые литералы файла. */
function literals(src: string): string[] {
  return [...src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
}

/**
 * Файл ОБЪЯВЛЯЕТ каталог вывода: среди его литералов есть путь, последний сегмент
 * которого — этот каталог (`'dist'`, `'../dist'`, `'web/dist-demo'`).
 *
 * Именно объявление, а не любое упоминание: сообщение вида «dist/ not found» тоже
 * содержит слово, но предметом файла не является, и по нему проверка приписала бы
 * предмет пояснительному тексту.
 */
function declaresDir(src: string, dir: string): boolean {
  return literals(src).some((s) => s === dir || s.endsWith(`/${dir}`));
}

/** Локальные импорты файла, разрешённые до существующих путей внутри web. */
function localImports(fileRelWeb: string): string[] {
  const src = sourceOf(fileRelWeb);
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g)].map((m) => m[2]);
  const base = dirname(join(WEB, fileRelWeb));
  const out: string[] = [];
  for (const spec of specs) {
    const candidates = [spec, `${spec}.ts`, `${spec}.mts`, `${spec}/index.ts`];
    for (const c of candidates) {
      const abs = resolve(base, c);
      if (existsSync(abs) && statSync(abs).isFile()) {
        out.push(relative(WEB, abs).replaceAll('\\', '/'));
        break;
      }
    }
  }
  return out;
}

/** Файл и все его локальные импорты, транзитивно. */
function importClosure(fileRelWeb: string, seen: Set<string> = new Set()): string[] {
  if (seen.has(fileRelWeb)) return [];
  seen.add(fileRelWeb);
  const out = [fileRelWeb];
  for (const dep of localImports(fileRelWeb)) out.push(...importClosure(dep, seen));
  return out;
}

/**
 * Предмет файла: каталоги, которые он читает сам или через импортированные модули.
 * Транзитивно — потому что проверка получает предмет ровно так: `import { dist } from
 * './helpers/dist-pages'`, и модуль, объявляющий корень, и есть источник предмета.
 */
function subjectsOf(fileRelWeb: string): Set<string> {
  const out = new Set<string>();
  for (const f of importClosure(fileRelWeb)) {
    const src = sourceOf(f);
    for (const dir of [PROD_DIST, DEMO_DIST]) if (declaresDir(src, dir)) out.add(dir);
  }
  return out;
}

/** Файлы, которые выбирает хотя бы одна конфигурация обязательного прогона. */
async function filesRunInGate(): Promise<{ file: string; config: string }[]> {
  const out: { file: string; config: string }[] = [];
  for (const wf of gatedWorkflows())
    for (const job of Object.values(wf.jobs))
      for (const step of job.steps)
        for (const config of vitestConfigsIn(stepCommand(step)))
          for (const file of selectedFiles(await configSelection(config)))
            out.push({ file, config });
  return out;
}

/** Шаги обязательного прогона, запускающие проверки по демо-выводу. */
async function demoCheckSteps(): Promise<{ wf: Workflow; job: WorkflowJob; step: WorkflowStep }[]> {
  const out: { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] = [];
  for (const wf of gatedWorkflows())
    for (const job of Object.values(wf.jobs))
      for (const step of job.steps) {
        let hit = false;
        for (const config of vitestConfigsIn(stepCommand(step))) {
          const files = selectedFiles(await configSelection(config)).filter((f) => f !== SELF);
          if (files.some((f) => subjectsOf(f).has(DEMO_DIST))) hit = true;
        }
        if (hit) out.push({ wf, job, step });
      }
  return out;
}

/** Шаги обязательного прогона, запускающие проверки по боевому выводу. */
async function prodCheckSteps(): Promise<{ wf: Workflow; job: WorkflowJob; step: WorkflowStep }[]> {
  const out: { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] = [];
  for (const wf of gatedWorkflows())
    for (const job of Object.values(wf.jobs))
      for (const step of job.steps) {
        let hit = false;
        for (const config of vitestConfigsIn(stepCommand(step))) {
          const files = selectedFiles(await configSelection(config)).filter((f) => f !== SELF);
          if (files.some((f) => subjectsOf(f).has(PROD_DIST))) hit = true;
        }
        if (hit) out.push({ wf, job, step });
      }
  return out;
}

function demoBuildSteps(): { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] {
  const out: { wf: Workflow; job: WorkflowJob; step: WorkflowStep }[] = [];
  for (const wf of gatedWorkflows())
    for (const job of Object.values(wf.jobs))
      for (const step of job.steps) if (isDemoBuildStep(step)) out.push({ wf, job, step });
  return out;
}

const where = (x: { wf: Workflow; job: WorkflowJob; step: WorkflowStep }): string =>
  `${x.wf.file}:${x.job.key}:шаг ${x.step.index} (${x.step.name ?? x.step.run?.slice(0, 40) ?? '—'})`;

// ───────────────────────────────────────────────────────────────────────────

describe('демо-гейт: положение внутри обязательного прогона', () => {
  // Сторож против вырождения. Всё ниже держится на трёх вещах: гейт называет
  // workflow, у этого workflow есть шаги, а машинерия разбора умеет находить в них
  // проверки по боевому выводу. Если гейт не объявлен или разбор перестал что-то
  // находить, остальные проверки говорили бы не о том — и молча.
  it('материал для проверки на месте', async () => {
    expect(gatedNames(), 'гейт публикации не называет ни одного workflow').not.toEqual([]);

    const gated = gatedWorkflows();
    const steps = gated.flatMap((wf) => Object.values(wf.jobs).flatMap((j) => j.steps));
    expect(steps.length, 'в обязательном прогоне нет ни одного шага').toBeGreaterThan(0);

    expect(
      Object.keys(webScripts).length,
      'в web/package.json нет скриптов — раскрывать команды шагов нечем',
    ).toBeGreaterThan(0);

    expect(
      testTreeFiles.length,
      `в ${TESTS_DIR} нет файлов — набор проверок пуст`,
    ).toBeGreaterThan(0);

    // Разбор обязан находить УЖЕ существующую пару «сборка + проверки по её выводу».
    // Иначе красный цвет проверок ниже означал бы поломку машинерии, а не отсутствие
    // демо-сборки в прогоне.
    const prodBuilds = gated.flatMap((wf) =>
      Object.values(wf.jobs).flatMap((j) =>
        j.steps.filter((s) => isSiteBuild(stepCommand(s))).map((s) => ({ wf, job: j, step: s })),
      ),
    );
    expect(
      prodBuilds.map(where),
      'в обязательном прогоне не найдено ни одного шага сборки сайта — разбор команд не работает',
    ).not.toEqual([]);

    const prod = await prodCheckSteps();
    expect(
      prod.map(where),
      'в обязательном прогоне не найдено проверок по боевому выводу — либо разбор ' +
        `конфигураций vitest не работает, либо каталог боевого вывода больше не '${PROD_DIST}'`,
    ).not.toEqual([]);
  });

  // Требование: «Прогон, успех которого является условием публикации, SHALL включать
  // сборку сайта в демо-режиме». Проверяется положение шага, а не наличие где-нибудь
  // в репозитории команды `build:demo`.
  it('сборка в демо-режиме входит в обязательный прогон', () => {
    const builds = demoBuildSteps();
    const looked = gatedWorkflows()
      .map((wf) => `${wf.file} (джобы: ${Object.keys(wf.jobs).join(', ')})`)
      .join('; ');
    expect(
      builds.map(where),
      `ни в одном джобе обязательного прогона нет шага, который собирает сайт в ` +
        `демо-режиме (сборщик плюс переключатель ${DEMO_SWITCH}). Смотрели: ${looked}`,
    ).not.toEqual([]);
  });

  // Требование: «…и проверки, предметом которых является её вывод». Шаг опознаётся по
  // предмету запускаемых им проверок, а не по имени скрипта: скрипт с любым названием,
  // читающий боевой вывод, демо-проверкой не является.
  it('проверки по выводу демо-сборки входят в обязательный прогон', async () => {
    const checks = await demoCheckSteps();
    expect(
      checks.map(where),
      'в обязательном прогоне нет шага, запускающего проверки по демо-выводу ' +
        `(каталог '${DEMO_DIST}'). Гейтом является ровно то, что лежит внутри прогона`,
    ).not.toEqual([]);
  });

  // Порядок: проверки по выводу не могут стоять раньше сборки, которая этот вывод
  // создаёт, — иначе они всегда работают по предмету, которого нет (или, хуже, по
  // выводу предыдущего прогона на самодержащемся runner'е).
  it('проверки демо-вывода стоят после демо-сборки, в том же джобе', async () => {
    const builds = demoBuildSteps();
    const checks = await demoCheckSteps();
    expect(
      builds.map(where),
      'нет шага демо-сборки — порядок проверять не на чем',
    ).not.toEqual([]);
    expect(checks.map(where), 'нет шага проверок по демо-выводу — порядок проверять не на чем').not.toEqual([]);

    // Сборка и проверки могут лежать и в ОДНОМ шаге (`build:demo && vitest --config …`) —
    // тогда порядок определяется положением команд внутри шага, а не индексами шагов.
    const buildBeforeChecksInside = (step: WorkflowStep): boolean => {
      const text = stepCommand(step);
      const build = text.search(/\bastro\s+build\b/);
      const run = text.search(/\bvitest\b/);
      return build !== -1 && run !== -1 && build < run;
    };

    const wrong = checks.filter(
      (c) =>
        !builds.some(
          (b) =>
            b.wf.file === c.wf.file &&
            b.job.key === c.job.key &&
            (b.step.index < c.step.index ||
              (b.step.index === c.step.index && buildBeforeChecksInside(c.step))),
        ),
    );
    expect(
      wrong.map(where),
      'проверки по демо-выводу стоят раньше демо-сборки или в другом джобе — предмета ' +
        'на момент их запуска не существует',
    ).toEqual([]);
  });

  // Решение 6 design.md и задача 6.3: демо-шаги ставятся в тот же джоб, где уже стоят
  // `npm ci` и сборка. Требование спеки удовлетворяют и отдельный джоб (гейт — весь
  // workflow целиком), поэтому проверка стережёт РЕШЕНИЕ change, а не текст требования:
  // отдельный джоб платил бы за установку зависимостей и сборку второй раз.
  it('решение 6: демо-шаги стоят в том же джобе, что и проверки боевого вывода', async () => {
    const demo = [...demoBuildSteps(), ...(await demoCheckSteps())];
    const prod = await prodCheckSteps();
    expect(demo.map(where), 'демо-шагов в обязательном прогоне нет — проверять положение нечего').not.toEqual([]);
    expect(prod.map(where), 'проверок боевого вывода в обязательном прогоне нет').not.toEqual([]);

    const prodJobs = new Set(prod.map((p) => `${p.wf.file}:${p.job.key}`));
    const outside = demo.filter((d) => !prodJobs.has(`${d.wf.file}:${d.job.key}`));
    expect(
      outside.map(where),
      `демо-шаги стоят вне джоба с боевой сборкой (${[...prodJobs].join(', ')}): ` +
        'отдельный джоб платит за npm ci и сборку второй раз (design.md, решение 6)',
    ).toEqual([]);
  });

  // Названный в спеке способ нарушить требование, не нарушая при этом требования
  // «Объём гейта назван явно»: вынести демо-сборку в отдельный workflow и перечислить
  // его среди невходящих. Перечень остаётся правдивым, публикацию такой workflow не
  // останавливает. На текущем коде демо-сборки нет ни в одном workflow, поэтому
  // проверка зелёная — она стережёт будущее.
  it('демо-сборка и её проверки не вынесены в workflow вне гейта', async () => {
    const nonGated = nonGatedWorkflows();
    expect(
      nonGated.map((w) => w.file),
      'нет ни одного workflow вне гейта — проверять вынос наружу не на чем',
    ).not.toEqual([]);

    const outside: string[] = [];
    for (const wf of nonGated)
      for (const job of Object.values(wf.jobs))
        for (const step of job.steps) {
          const text = stepCommand(step);
          if (isDemoBuildStep(step))
            outside.push(`${wf.file}:${job.key}:шаг ${step.index} — сборка в демо-режиме`);
          for (const config of vitestConfigsIn(text)) {
            const files = selectedFiles(await configSelection(config)).filter((f) => f !== SELF);
            if (files.some((f) => subjectsOf(f).has(DEMO_DIST)))
              outside.push(
                `${wf.file}:${job.key}:шаг ${step.index} — проверки по демо-выводу (${config})`,
              );
          }
        }

    expect(
      outside,
      'демо-проверки лежат в workflow вне гейта, то есть публикацию не останавливают:\n' +
        outside.join('\n'),
    ).toEqual([]);
  });

  // Внутри прогона можно лежать и ничего при этом не останавливать: шаг с
  // `continue-on-error: true` падает, а прогон остаётся успешным; джоб с тем же
  // ключом — тоже; условие, ложное для push в основную ветку, не выполняется как раз
  // для тех коммитов, из-за которых происходит публикация.
  it('падение демо-проверок не замаскировано и они выполняются на коммиты основной ветки', async () => {
    const demo = [...demoBuildSteps(), ...(await demoCheckSteps())];
    expect(
      demo.map(where),
      'демо-шагов в обязательном прогоне нет — маскировку проверять не на чем',
    ).not.toEqual([]);

    const problems: string[] = [];
    const push = pushContext(DEFAULT_BRANCH);
    for (const d of demo) {
      const raw = JSON.parse(d.step.raw) as Record<string, unknown>;
      if (raw['continue-on-error'] === true || raw['continue-on-error'] === 'true')
        problems.push(`${where(d)} — continue-on-error у шага: падение не делает прогон неуспешным`);
      if (d.job.continueOnError === true || d.job.continueOnError === 'true')
        problems.push(`${where(d)} — continue-on-error у джоба ${d.job.key}`);
      for (const { source, expr } of conditionsGuarding(d.wf, d.job.key, d.step))
        if (!canBeTrue(expr, push))
          problems.push(
            `${where(d)} — условие ${source}: '${expr}' ложно для push в ${DEFAULT_BRANCH}: ` +
              'на коммиты основной ветки демо-проверки не выполнятся',
          );
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('демо-гейт: два вывода — два предмета', () => {
  // Требование: «проверка, написанная про один из них, SHALL NOT получать на вход
  // другой». Первая половина — со стороны сборки: пока демо-сборка пишет в боевой
  // каталог, предметом проверки становится та сборка, которая закончилась последней,
  // то есть свойство расположения шагов, а не предмета.
  //
  // Проверяются ВСЕ скрипты пакета, а не только тот, который вызван из workflow:
  // скрипт, пишущий демо-вывод в боевой каталог, — заряженная мина независимо от того,
  // кто его сегодня вызывает.
  it('сборка в демо-режиме не пишет в боевой каталог', () => {
    const demoScripts = Object.entries(webScripts).filter(([name]) => {
      const text = expandNpm(`npm run ${name}`);
      return isSiteBuild(text) && text.includes(DEMO_SWITCH);
    });
    expect(
      demoScripts.map(([name]) => name),
      `в web/package.json нет ни одного скрипта, собирающего сайт с ${DEMO_SWITCH} — ` +
        'предмет проверки отсутствует',
    ).not.toEqual([]);

    const offenders = demoScripts
      .map(([name]) => {
        const text = expandNpm(`npm run ${name}`);
        const bad = commandChunks(text).filter(
          (chunk) => mentionsDir(chunk, PROD_DIST) && !/^\s*npm\s/.test(chunk),
        );
        return bad.length === 0 ? null : `${name}: ${bad.map((b) => b.trim()).join(' | ')}`;
      })
      .filter((x): x is string => x !== null);

    expect(
      offenders,
      `демо-сборка обращается к боевому каталогу '${PROD_DIST}' — вывод одной сборки ` +
        `перекрывает вывод другой, и предмет проверок определяется порядком шагов:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  // Вторая половина — со стороны проверок: у каждой ровно один предмет. Предмет
  // определяется тем, какой корень файл объявляет сам или получает из импортированного
  // модуля, — то есть тем, что проверка фактически читает.
  it('у каждой проверки обязательного прогона ровно один предмет', async () => {
    const inGate = await filesRunInGate();
    expect(inGate.map((x) => x.file), 'обязательный прогон не выбирает ни одного файла').not.toEqual([]);

    const files = [...new Set(inGate.filter((x) => x.file !== SELF).map((x) => x.file))];
    const withSubject = files.map((f) => ({ file: f, subjects: subjectsOf(f) }));

    const prod = withSubject.filter((x) => x.subjects.has(PROD_DIST)).map((x) => x.file);
    const demo = withSubject.filter((x) => x.subjects.has(DEMO_DIST)).map((x) => x.file);

    expect(prod, `в обязательном прогоне нет проверок по боевому выводу '${PROD_DIST}'`).not.toEqual([]);
    expect(
      demo,
      `в обязательном прогоне нет ни одной проверки, предметом которой был бы демо-вывод ` +
        `'${DEMO_DIST}'. Пустой набор — это «не выполнено», а не «нарушений нет»`,
    ).not.toEqual([]);

    const both = withSubject
      .filter((x) => x.subjects.has(PROD_DIST) && x.subjects.has(DEMO_DIST))
      .map((x) => `${x.file} — читает и '${PROD_DIST}', и '${DEMO_DIST}'`);
    expect(
      both,
      'проверка получает на вход оба вывода: предмет определяется не тем, про что она ' +
        'написана, а тем, какой корень ей достался:\n' + both.join('\n'),
    ).toEqual([]);
  });
});

describe('демо-гейт: предмета нет — «не выполнено»', () => {
  /** Каталог, изображающий непустой вывод сборки: страницы, ассеты, индекс поиска. */
  function populated(root: string): string {
    for (const page of ['', '404', 'statyi', 'preview/editorial', 'preview/faculty', 'preview/modular'])
      write(join(root, page, page === '404' ? '' : 'index.html'), '<!doctype html><html lang="ru"><body>демо</body></html>');
    write(join(root, '_astro', 'style.css'), 'body{color:#000}');
    write(join(root, 'pagefind', 'pagefind.js'), 'export {};');
    return root;
  }

  function write(file: string, text: string): void {
    const target = file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.js') ? file : `${file}.html`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  // Сценарий «демо-вывода нет вовсе»: «проверка, лишившаяся своего предмета — вывод
  // отсутствует, список проверяемых файлов пуст, — SHALL считаться непройденной, а не
  // пройденной».
  //
  // Проверяется вызовом, а не чтением кода: среди модулей, через которые демо-проверки
  // получают предмет, обязана быть функция, которая на пустом каталоге ПАДАЕТ, а на
  // непустом — нет. Первое без второго прошло бы и для функции, падающей всегда.
  //
  // Тестовые файлы не импортируются (импорт `*.test.ts` внутри прогона зарегистрировал
  // бы чужие проверки как свои) — предмет берётся из модулей их замыкания.
  it('перечисление демо-вывода считает пустой каталог провалом', async () => {
    const checks = await demoCheckSteps();
    expect(
      checks.map(where),
      'проверок по демо-выводу в обязательном прогоне нет — сценарий «демо-вывода нет ' +
        'вовсе» проверять не на чем',
    ).not.toEqual([]);

    const demoFiles = new Set<string>();
    for (const c of checks)
      for (const config of vitestConfigsIn(stepCommand(c.step)))
        for (const f of selectedFiles(await configSelection(config)))
          if (f !== SELF && subjectsOf(f).has(DEMO_DIST)) demoFiles.add(f);

    const modules = [...new Set([...demoFiles].flatMap((f) => importClosure(f)))].filter(
      (f) => !/\.test\.ts$/.test(f) && /\.m?ts$/.test(f),
    );
    expect(
      modules,
      'демо-проверки не берут предмет ни из одного модуля: перечисление вывода лежит ' +
        'внутри тестового файла, и вызвать его отдельно нельзя. Сценарий требует, чтобы ' +
        'пустой предмет ронял проверку — значит перечисление должно быть вызываемым',
    ).not.toEqual([]);

    const empty = mkdtempSync(join(tmpdir(), 'demo-subject-empty-'));
    const full = populated(mkdtempSync(join(tmpdir(), 'demo-subject-full-')));
    const tried: string[] = [];
    let guard: string | null = null;
    try {
      for (const file of modules) {
        const mod = (await import(pathToFileURL(join(WEB, file)).href)) as Record<string, unknown>;
        for (const [name, value] of Object.entries(mod)) {
          if (typeof value !== 'function') continue;
          // Число объявленных параметров не фильтр: у естественной подписи
          // `demoPages(root = demoDist)` оно равно нулю, и фильтр по арности пропустил
          // бы именно ту функцию, которую ищем (проверено — так и вышло).
          const fn = value as (root: string) => unknown;
          let failsOnEmpty = false;
          try {
            fn(empty);
          } catch {
            failsOnEmpty = true;
          }
          let worksOnFull = true;
          try {
            fn(full);
          } catch {
            worksOnFull = false;
          }
          tried.push(`${file}:${name} — пустой: ${failsOnEmpty ? 'падает' : 'проходит'}, непустой: ${worksOnFull ? 'проходит' : 'падает'}`);
          if (failsOnEmpty && worksOnFull) guard = `${file}:${name}`;
        }
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(full, { recursive: true, force: true });
    }

    expect(
      guard,
      'ни одна функция, через которую демо-проверки получают предмет, не падает на ' +
        'пустом каталоге вывода: пустой предмет пройдёт как «нарушений нет». Проверено:\n' +
        (tried.join('\n') || '— вызываемых функций с аргументом-каталогом не найдено'),
    ).not.toBeNull();
  });
});
