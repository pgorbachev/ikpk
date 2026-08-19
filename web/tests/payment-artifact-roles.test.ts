/**
 * ПРОВОДКА браузерных наборов оплаты по РОЛИ АРТЕФАКТА (задача 6.15).
 *
 * Источник требования: `openspec/changes/online-payment-flow/tasks.md`, задача 6.15
 * (решение владельца от 2026-08-19, находка D3): `payment-form-demo.spec.ts` — артефакт роли
 * `preview`, `payment-form.spec.ts` — артефакт роли `stand`, конфигурации Playwright для них
 * разведены (прежде `playwright.demo.config.ts` противопоставлялся основному по `DEMO_FORMS`
 * — признаку форм ЗАЯВКИ, а не по роли артефакта).
 *
 * ПРЕДМЕТ — именно проводка, и он отличается от двух соседних:
 *  - какую роль объявляет ЖИВАЯ страница набора — предмет самих наборов
 *    (`payment-form.spec.ts` и `payment-form-demo.spec.ts`, describe «6.15 артефакт набора…»);
 *  - что объявляет СТАТИЧЕСКИЙ артефакт — предмет `payment-role-dist.test.ts` и
 *    `preview-role-dist.test.ts`;
 *  - здесь: какой набор какой артефакт получает и запускает ли его обязательный прогон.
 * Разные предметы названы нарочно: три проверки об одном дали бы три ответа и каждая
 * исправляла бы то, что ломают другие.
 *
 * КАТАЛОГ ВЫВОДА РОЛИ НЕ ВЫПИСАН ЗДЕСЬ ИМЕНЕМ, а извлекается из её же скрипта сборки:
 * проверяется отображение «роль → сборка → раздача». Вторая причина техническая и названа,
 * чтобы её не сняли как излишнюю: `demo-gate.test.ts` приписывает файлу ПРЕДМЕТ по
 * объявленному литералу каталога вывода — транзитивно, через импорты, — и файл про проводку,
 * назвавший оба каталога, превратил бы каждый шаг обязательного прогона в «проверку
 * демо-вывода». Проверено на себе: с литералами в этом файле и в его хелпере краснели два
 * чужих гейта.
 *
 * ВЫБОР НАБОРА ПРОВЕРЯЕТСЯ САМИМ PLAYWRIGHT (`--list --reporter=json`), а не разбором glob'ов
 * своими руками: приблизительный разбор `testMatch`/`testIgnore` отвечал бы за Playwright, и
 * расхождение в семантике осталось бы незамеченным. Тот же приём уже применён мета-гейтом
 * расписания (`scripts/check-month-run.ts`).
 *
 * ПОЧЕМУ ЗЕЛЁНЫЕ СЕЙЧАС: предмет — проводка, которую эта же поставка и делает. Красное здесь
 * означало бы, что разведение не доехало; регрессионная ценность в том, что молча вернуть
 * набор на чужой артефакт или выкинуть шаг из обязательного прогона больше нельзя.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  BROWSER_ARTIFACTS,
  PAYMENT_ROLE_ENV,
  RETIRED_DEMO_NPM_SCRIPT,
  RETIRED_DEMO_PLAYWRIGHT_CONFIG,
  type BrowserRole,
} from './helpers/payment-artifacts';
import { RETIRED_DEMO_ATTR } from './helpers/payment-contract';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const MAIN_CONFIG = 'playwright.config.ts';
const MANDATORY_WORKFLOW = join(repoRoot, '.github', 'workflows', 'test.yml');

const ROLES = Object.keys(BROWSER_ARTIFACTS) as BrowserRole[];

type Selection = { file: string; projects: string[] };

/** Что набор ФАКТИЧЕСКИ выбирает: спрашиваем Playwright, а не разбираем glob'ы сами. */
function listSelected(config: string): Selection[] {
  const run = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json', '--config', config], {
    cwd: webRoot,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: '' },
  });
  if (run.status !== 0) {
    throw new Error(
      `playwright --list по ${config} завершился кодом ${run.status}: набор не собрался, ` +
        `то есть измерения нет — это отказ, а не «нарушений не найдено».\n${run.stderr ?? ''}`,
    );
  }
  const raw = run.stdout ?? '';
  const start = raw.indexOf('{');
  if (start < 0) throw new Error(`playwright --list по ${config} не отдал JSON: ${raw.slice(0, 200)}`);
  const report = JSON.parse(raw.slice(start)) as {
    suites?: unknown[];
  };
  const found = new Map<string, Set<string>>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const suite = node as {
      file?: string;
      suites?: unknown[];
      specs?: { file?: string; tests?: { projectName?: string }[] }[];
    };
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file;
      if (!file) continue;
      const projects = found.get(file) ?? new Set<string>();
      for (const t of spec.tests ?? []) if (t.projectName) projects.add(t.projectName);
      found.set(file, projects);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return [...found].map(([file, projects]) => ({ file, projects: [...projects].sort() }));
}

type PlaywrightConfigShape = {
  use?: { baseURL?: string; launchOptions?: { args?: string[] } };
  webServer?: { command?: string; port?: number };
  projects?: { name?: string }[];
};

const selections = new Map<string, Selection[]>();
const configs = new Map<string, PlaywrightConfigShape>();

beforeAll(async () => {
  for (const config of [MAIN_CONFIG, ...ROLES.map((r) => BROWSER_ARTIFACTS[r].playwrightConfig)]) {
    selections.set(config, listSelected(config));
    const mod = (await import(join(webRoot, config))) as { default: PlaywrightConfigShape };
    configs.set(config, mod.default);
  }
}, 120_000);

describe('6.15 каждой роли — свой набор, и наоборот', () => {
  for (const role of ROLES) {
    const artifact = BROWSER_ARTIFACTS[role];

    it(`конфигурация роли ${role} выбирает ровно ${artifact.spec}`, () => {
      const picked = selections.get(artifact.playwrightConfig)!;
      // Пустой набор — «не выполнено», а не «нарушений нет»: конфигурация, не выбравшая ни
      // одного файла, зелена ровно потому, что ничего не проверяет.
      expect(
        picked.map((p) => p.file),
        `набор роли ${role} пуст — проверка не пройдена`,
      ).not.toEqual([]);
      expect(picked.map((p) => p.file).sort()).toEqual([artifact.spec.replace(/^tests\//, '')]);
    });

    it(`конфигурация роли ${role} раздаёт артефакт своей сборки на порту ${artifact.port}`, () => {
      const cfg = configs.get(artifact.playwrightConfig)!;
      const command = cfg.webServer?.command ?? '';
      expect(command, `конфигурация роли ${role} не поднимает сервер вовсе`).not.toBe('');
      // Ожидаемый каталог берётся из СБОРКИ этой роли, а не из ещё одной копии имени:
      // расхождение «собрали одно, раздали другое» иначе не ловится ничем.
      const built = outDirOf(scripts()[artifact.buildScript] ?? '');
      expect(built, `скрипт ${artifact.buildScript} не задаёт каталог вывода — сверять не с чем`).toBeTruthy();
      expect(outDirOf(command), `набор роли ${role} раздаёт не то, что собрал ${artifact.buildScript}`).toBe(built);
      // У `astro preview` нет флага `--outDir`: каталог ВЫБИРАЕТ конфигурация astro, а
      // `--outDir` обёртка лишь сверяет с фактически отданным содержимым.
      expect(command).toContain(`--config ${artifact.astroConfig}`);
      expect(command).toContain(`--port ${artifact.port}`);
      expect(cfg.webServer?.port).toBe(artifact.port);
      expect(cfg.use?.baseURL).toBe(`http://127.0.0.1:${artifact.port}`);
    });

    it(`роль ${role} выбирается переменной ${PAYMENT_ROLE_ENV}, а не признаком DEMO_FORMS`, () => {
      const cfg = configs.get(artifact.playwrightConfig)!;
      // Раздача роль не задаёт — её задаёт СБОРКА. Проверяется именно это отображение.
      const build = scripts()[artifact.buildScript];
      expect(build, `скрипта сборки ${artifact.buildScript} нет — артефакт роли ${role} собрать нечем`).toBeTruthy();
      expect(build).toContain(`${PAYMENT_ROLE_ENV}=${role}`);
      // Признак прежней матрицы в выборе артефакта не участвует.
      expect(cfg.webServer?.command ?? '').not.toContain('DEMO_FORMS');
      expect(cfg.webServer?.command ?? '').not.toContain(RETIRED_DEMO_ATTR);
    });

    it(`fail-closed guard взведён в наборе роли ${role}`, () => {
      const source = readFileSync(join(webRoot, artifact.spec), 'utf8');
      expect(
        source,
        `набор роли ${role} не ставит guard: неперехваченный запрос к платёжному контуру ушёл бы молча`,
      ).toContain(`installFailClosedGuard(page, '${role}')`);
      expect(source).toContain('expectNoEscapes(guard)');
      const cfg = configs.get(artifact.playwrightConfig)!;
      // Слой 1 (внешние имена не разрешаются) и слой 2 (перехват, называющий предмет) —
      // разные, и проверять надо оба: без слоя 1 запрос, ушедший мимо интерцептора, уходит в
      // живую сеть; без слоя 2 отказ безымянен и читается как «что-то с сетью».
      const args = (cfg.use?.launchOptions?.args ?? []).join(' ');
      expect(
        args,
        `в наборе роли ${role} внешние имена разрешаются — забытый мок уйдёт в живую сеть`,
      ).toMatch(/--host-resolver-rules=[^']*~NOTFOUND/);
    });
  }

  it('наборы ролей не смешаны: разные артефакты, разные порты, разные конфигурации', () => {
    const outDirs = ROLES.map((r) => outDirOf(configs.get(BROWSER_ARTIFACTS[r].playwrightConfig)!.webServer?.command ?? ''));
    const ports = ROLES.map((r) => configs.get(BROWSER_ARTIFACTS[r].playwrightConfig)!.webServer?.port);
    const specs = ROLES.map((r) => BROWSER_ARTIFACTS[r].spec);
    expect(outDirs.filter(Boolean).length, 'каталог раздачи не объявлен — сверять нечего').toBe(ROLES.length);
    expect(new Set(outDirs).size).toBe(ROLES.length);
    expect(new Set(ports).size).toBe(ROLES.length);
    expect(new Set(specs).size).toBe(ROLES.length);
    // Порт основного набора (над боевым выводом) занят третьим сервером — совпадение увело бы
    // набор роли на чужой артефакт, а при `reuseExistingServer: false` вовсе сняло бы прогон.
    expect(ports).not.toContain(configs.get(MAIN_CONFIG)!.webServer?.port);
  });

  it('основной набор платёжных клиентских наборов не подхватывает', () => {
    const picked = selections.get(MAIN_CONFIG)!.map((p) => p.file);
    expect(picked, 'основной набор пуст — проверка не пройдена').not.toEqual([]);
    for (const role of ROLES) {
      const spec = BROWSER_ARTIFACTS[role].spec.replace(/^tests\//, '');
      expect(picked, `${spec} идёт на артефакте, роль которого не его`).not.toContain(spec);
    }
  });

  it(`конфигурация прежней матрицы (${RETIRED_DEMO_PLAYWRIGHT_CONFIG}) не вернулась`, () => {
    expect(existsSync(join(webRoot, RETIRED_DEMO_PLAYWRIGHT_CONFIG))).toBe(false);
    expect(Object.keys(scripts())).not.toContain(RETIRED_DEMO_NPM_SCRIPT);
  });
});

/** Каталог вывода, объявленный командой: `--outDir <каталог>`. */
function outDirOf(command: string): string | undefined {
  return /--outDir[=\s]+(\S+)/.exec(command)?.[1];
}

function scripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe('6.15 наборы ролей запускает обязательный прогон, а не только локальная воля', () => {
  type Step = { name?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
  type Job = { steps?: Step[]; env?: Record<string, unknown> };
  const workflow = () => parse(readFileSync(MANDATORY_WORKFLOW, 'utf8')) as {
    name?: string;
    jobs?: Record<string, Job>;
  };

  /** Все значения, которые джоб передаёт в окружение: свои и всех своих шагов. */
  function envValues(job: Job): string[] {
    return [job.env ?? {}, ...(job.steps ?? []).map((s) => s.env ?? {})].flatMap((env) =>
      Object.values(env).map((v) => String(v)),
    );
  }

  for (const role of ROLES) {
    const artifact = BROWSER_ARTIFACTS[role];

    it(`npm-скрипт ${artifact.npmScript} запускает набор роли ${role} своей конфигурацией`, () => {
      const script = scripts()[artifact.npmScript];
      expect(script, `скрипта ${artifact.npmScript} нет — набор роли ${role} нечем запустить`).toBeTruthy();
      expect(script).toContain(`--config=${artifact.playwrightConfig}`);
      // Сброс фонового preview обязан смотреть на СВОЙ порт: с astro 7.2+ сервер уходит в фон
      // и переживает прогон, а reset по чужому порту оставил бы порт занятым.
      expect(script).toContain(`PREVIEW_PORT=${artifact.port}`);
      expect(script).toContain('preview-reset.mjs');
    });

    it(`${MANDATORY_WORKFLOW.split('/').pop()} запускает ${artifact.npmScript} и готовит его артефакт`, () => {
      const wf = workflow();
      // Гейт публикации — один workflow `Tests`; проверка, положенная в файл, который не
      // запускает никто, зелена именно потому, что её не выполняют.
      expect(wf.name, 'разобран не тот workflow').toBe('Tests');
      const jobs = Object.values(wf.jobs ?? {});
      const steps = jobs.flatMap((j) => j.steps ?? []);
      const runIndex = steps.findIndex((s) => (s.run ?? '').includes(artifact.npmScript));
      expect(runIndex, `${artifact.npmScript} не запускается ни одним шагом обязательного прогона`).toBeGreaterThanOrEqual(0);
      // Артефакт роли должен появиться ДО прогона: собран здесь либо скачан из другого джоба.
      // Каталог берётся из скрипта сборки этой роли, а не из копии имени.
      const built = outDirOf(scripts()[artifact.buildScript] ?? '');
      expect(built, `скрипт ${artifact.buildScript} не задаёт каталог вывода — сверять нечего`).toBeTruthy();
      const prepared = steps.slice(0, runIndex).some((s) => {
        const run = s.run ?? '';
        const path = String(s.with?.path ?? '');
        return run.includes(artifact.buildScript) || path.endsWith(built!);
      });
      expect(
        prepared,
        `артефакт роли ${role} (${built}) к моменту прогона не готов: набор без своего ` +
          `артефакта не проверяет ничего`,
      ).toBe(true);
    });

    it(`джоб с прогоном роли ${role} не получает секретов, кроме токена самого GitHub`, () => {
      // Требование 6.15 дословно: «живая ЮKassa в обязательном прогоне не используется, её
      // секреты в CI не передаются». Проверяется общий признак — ЛЮБАЯ подстановка секрета, —
      // а не перечень известных имён: список имён отстал бы от предмета молча, стоит завести
      // ещё один секрет. Исключение ровно одно и названо поимённо: `GITHUB_TOKEN` выдаётся
      // самим GitHub и к ЮKassa отношения не имеет.
      const wf = workflow();
      const job = Object.values(wf.jobs ?? {}).find((j) =>
        (j.steps ?? []).some((s) => (s.run ?? '').includes(artifact.npmScript)),
      );
      expect(job, `джоб с прогоном роли ${role} не найден — проверять нечего`).toBeTruthy();
      expect((job!.steps ?? []).length, 'у джоба нет шагов — разбор сломан').toBeGreaterThan(0);
      const secrets = envValues(job!)
        .flatMap((v) => [...v.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))
        .filter((name) => name !== 'GITHUB_TOKEN');
      expect(
        [...new Set(secrets)],
        `в прогон роли ${role} передаются секреты: живой контур в обязательном прогоне не участвует`,
      ).toEqual([]);
    });
  }
});
