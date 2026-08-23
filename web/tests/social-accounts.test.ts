/**
 * Состав внешних аккаунтов: ИСТОЧНИК, НЕЗАВИСИМОСТЬ ОЖИДАНИЙ и ПОКРЫТИЕ РОЛЕЙ.
 *
 * Предмет этого файла — не собранный вывод (он у проверок по ролям), а три вещи, которые в
 * выводе не наблюдаются вовсе:
 *  - единый источник состава и отсутствие вторых определений адреса в продуктовом коде
 *    (Requirement «Состав внешних аккаунтов закрыт перечнем», сценарий «адрес имеет второе
 *    определение»);
 *  - независимость ожиданий проверки от источника состава (Requirement «Ожидания проверки
 *    независимы от источника состава», оба сценария);
 *  - покрытие каждой роли артефакта своим предметом и поведение проверки, лишившейся
 *    предмета (Requirement «Области двух половин проверки различны…», сценарии «каждая роль
 *    проверена своим артефактом», «перечень страниц пуст», «подвал пуст, а адрес есть на
 *    странице»);
 *  - прочтение реестра применимости марок (Requirement «Решение о применимости марки
 *    зафиксировано в машиночитаемом реестре», все три сценария, плюс сценарий «текстом
 *    осталось больше одной сети» соседнего Requirement): предмет — правило прочтения
 *    записи, а не сам реестр, поэтому это чистая функция на придуманных записях.
 *
 * Плюс объявление порога цветового расстояния и его контрольная пара (Requirement «Youtube и
 * Rutube отличимы друг от друга»): это чистая функция, и её место здесь, а не в браузере.
 *
 * ПОЧЕМУ КРАСНЫЙ СЕЙЧАС — по каждой проверке отдельно, в её собственном комментарии.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ACCEPTED_ACCOUNTS,
  RETIRED_NETWORKS,
  markDecision,
  networksRequiringMark,
  networksWithoutDecision,
  outputPages,
  retiredMentions,
  socialColumn,
  textLinkOverflow,
  type MarkRegistryEntry,
} from './helpers/social-accounts-contract';
import {
  deltaE76,
  CONTROL_ANCHOR,
  CONTROL_PAIR,
  CONTROL_PAIR_FACTOR,
  COLOR_DISTANCE_THRESHOLD,
} from './helpers/contrast';
import { loadWorkflows, publishingWorkflows, workflowRunTrigger, type Workflow } from './helpers/workflows';

const WEB_ROOT = join(import.meta.dirname, '..');
const SRC_ROOT = join(WEB_ROOT, 'src');
const TESTS_DIR = import.meta.dirname;

function* sourceFiles(dir: string = SRC_ROOT): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|js|mjs|astro|md)$/.test(name)) yield full;
  }
}

/**
 * Код без комментариев. Предмет требования — ОПРЕДЕЛЕНИЕ адреса, а в комментариях этого
 * же файла названы прежние, уже мёртвые адреса (`vk.com/ikpksu`, `youtube.com/@ikpk_su`) —
 * проверка по всему тексту краснела бы на объяснении дефекта.
 *
 * Строки НЕ выбрасываются, а очищаются: сообщение проверки называет номер строки, и
 * выброшенный комментарий сдвинул бы все номера ниже него. Ложный номер в сообщении хуже
 * отсутствующего — по нему исполнитель идёт не туда.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

/** Адрес в сравнимой форме: без схемы, `www.` и завершающего слэша. */
function normalizeAddress(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

describe('состав внешних аккаунтов: единый источник', () => {
  /**
   * ПОЧЕМУ КРАСНЫЙ: в перечне шесть записей, а требование называет четыре
   * (`web/src/lib/social.ts:21`, `export const SOCIAL_LINKS: SocialLink[] = [`).
   *
   * Ожидание берётся из `helpers/social-accounts-contract.ts`, а не из проверяемого модуля:
   * иначе правка модуля сдвинула бы обе стороны сравнения сразу.
   */
  it('перечень в источнике состава равен принятому', async () => {
    const mod = (await import('../src/lib/social.js')) as {
      SOCIAL_LINKS?: Array<{ label: string; href: string }>;
    };
    const links = mod.SOCIAL_LINKS;
    expect(Array.isArray(links), 'источник состава не отдаёт перечня — проверять нечего').toBe(true);
    expect(
      links!.map((l) => `${l.label} ${l.href}`),
      'состав в источнике не равен принятому перечню',
    ).toEqual(ACCEPTED_ACCOUNTS.map((a) => `${a.name} ${a.href}`));
  });

  /**
   * ПОЧЕМУ КРАСНЫЙ: адрес аккаунта из перечня имеет два вторых определения в продуктовом
   * коде — `web/src/lib/social.ts:48`, `export const VK_COMMUNITY_URL = 'https://vk.com/clubikpk';`
   * и `web/src/lib/video-mirrors.ts:25`, `export const RUTUBE_CHANNEL_URL = 'https://rutube.ru/channel/30422569/';`
   *
   * Сравнение идёт по НОРМАЛИЗОВАННОМУ адресу, а не по буквальному литералу: второе
   * определение, написанное без завершающего слэша или без `www.`, ведёт на тот же аккаунт,
   * и признак по буквальному совпадению его бы не увидел.
   */
  it('адрес аккаунта не имеет второго определения в продуктовом коде', () => {
    const accepted = new Map(ACCEPTED_ACCOUNTS.map((a) => [normalizeAddress(a.href), a.name]));
    const places: Array<{ name: string; at: string; literal: string }> = [];
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      const lines = code.split('\n');
      lines.forEach((line, index) => {
        for (const m of line.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)) {
          const name = accepted.get(normalizeAddress(m[1]!));
          if (name !== undefined) {
            places.push({
              name,
              at: `${relative(WEB_ROOT, file)}:${index + 1}`,
              literal: m[1]!,
            });
          }
        }
      });
    }

    const byNetwork = new Map<string, typeof places>();
    for (const place of places) {
      byNetwork.set(place.name, [...(byNetwork.get(place.name) ?? []), place]);
    }

    const zero = ACCEPTED_ACCOUNTS.filter((a) => !byNetwork.has(a.name)).map((a) => a.name);
    expect(
      zero,
      `адрес этих сетей не найден в продуктовом коде вовсе — проверять было нечего: ${zero.join(', ')}`,
    ).toEqual([]);

    const duplicated = [...byNetwork.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([name, list]) => `${name}: ${list.map((p) => `${p.at} (${p.literal})`).join(' + ')}`);
    expect(
      duplicated,
      `у адреса аккаунта есть второе независимое определение в продуктовом коде:\n${duplicated.join('\n')}`,
    ).toEqual([]);
  });
});

describe('состав внешних аккаунтов: ожидания проверки независимы от источника', () => {
  const CHECK_FILES = [
    'helpers/social-accounts-contract.ts',
    'social-accounts-ci-dist.test.ts',
    'social-accounts-preview-dist.test.ts',
    'social-accounts-stand-dist.test.ts',
  ];

  /**
   * Сценарии «аккаунт удалён из источника состава» и «в источник состава добавлена снятая
   * сеть» описывают поведение проверки при ПРАВКЕ ПРОДУКТА — стоящим тестом это не
   * выражается, потому что тест не пересобирает сайт. Стоящим тестом проверяется то, из
   * чего это поведение следует: замыкание импортов проверки не содержит источника состава.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ. Свидетельство для него — негативная мутация (задачи 5.1 и 5.2),
   * а не красный прогон: он охраняет уже принятое решение от бесшумной отмены.
   */
  it('ни один файл проверки состава не читает источник состава', () => {
    const offenders: string[] = [];
    for (const rel of CHECK_FILES) {
      const file = join(TESTS_DIR, rel);
      expect(existsSync(file), `нет файла проверки ${rel} — проверять нечего`).toBe(true);
      const code = stripComments(readFileSync(file, 'utf-8'));
      // Граница имени модуля обязательна: без `(?![\w-])` признак `lib/social` совпадает и
      // с `lib/social-marks-registry` — а тот источником СОСТАВА не является и, наоборот,
      // должен читаться проверкой (Requirement «Решение о применимости марки зафиксировано
      // в машиночитаемом реестре» прямо требует, чтобы решение владельца читала автоматика).
      // Признак по префиксу запрещал бы то, что требование предписывает.
      if (/(from|import)\s*\(?\s*['"][^'"]*(lib\/social|lib\/video-mirrors)(?![\w-])/.test(code)) {
        offenders.push(`${rel}: читает источник состава продукта`);
      }
    }
    expect(
      offenders,
      `проверка, читающая ожидания из проверяемого источника, зелена по построению:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /** Пустое объявление ожиданий прошло бы любую сверку — это провал, а не успех. */
  it('перечни ожиданий не пусты и не пересекаются', () => {
    expect(ACCEPTED_ACCOUNTS.length, 'принятый состав пуст — сверять нечего').toBeGreaterThan(0);
    expect(RETIRED_NETWORKS.length, 'перечень снятых сетей пуст — сверять нечего').toBeGreaterThan(0);
    const accepted = ACCEPTED_ACCOUNTS.map((a) => a.href.toLowerCase());
    const clash = RETIRED_NETWORKS.filter((r) => accepted.some((href) => href.includes(r.host)));
    expect(clash.map((c) => c.name), 'сеть числится и принятой, и снятой').toEqual([]);
  });
});

describe('состав внешних аккаунтов: проверка различает «нарушений нет» и «не смогла проверить»', () => {
  /**
   * Сценарий «перечень страниц пуст»: проверка, лишившаяся предмета, обязана считаться
   * непройденной. Проверяется на трёх состояниях корня, а не на одном: отсутствующий,
   * не-каталог и пустой каталог — три разные ветки, и непройденная ветка это такое же
   * обещание, как непроверенный гейт.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — поведение самой проверки, оно уже написано.
   */
  it('пустой или отсутствующий вывод роняет перечисление страниц', () => {
    const missing = join(tmpdir(), 'social-accounts-no-such-root-42');
    expect(() => outputPages(missing, 'npm run build')).toThrow(/предмета проверки нет/);

    const dir = mkdtempSync(join(tmpdir(), 'social-accounts-empty-'));
    try {
      expect(() => outputPages(dir, 'npm run build')).toThrow(/html-страниц в выводе нет/);
      expect(() => outputPages(join(dir, 'as-file'), 'npm run build')).toThrow(/предмета проверки нет/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Сценарий «подвал пуст, а адрес есть на странице»: половина «присутствует» мерится
   * ВНУТРИ подвала, поэтому наличие адреса вне подвала её не успокаивает.
   *
   * Проверяется на фикстуре, а не на выводе: в выводе такого состояния нет, а именно оно и
   * есть предмет — «проверка по всей странице не обнаруживает исчезновение отдельного
   * аккаунта». Измерено на выводе роли `ci`: адреса ВКонтакте и Rutube вне подвала есть
   * (7 и 1 страница), Youtube и Telegram — нет ни на одной.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — область измерения, а не состав продукта.
   */
  it('адрес вне подвала не закрывает отсутствие аккаунта в подвале', () => {
    const vk = ACCEPTED_ACCOUNTS[0]!;
    const html = [
      '<html><body><main>',
      `<a href="${vk.href}">Наше сообщество</a>`,
      '</main><footer><div><h2>Подписывайтесь</h2><ul></ul></div></footer></body></html>',
    ].join('');

    const column = socialColumn(html);
    expect(column.container, 'колонка «Подписывайтесь» в фикстуре не найдена').not.toBeNull();
    expect(
      column.links.map((l) => l.href),
      'в колонке подвала фикстуры не должно быть ни одной ссылки',
    ).toEqual([]);
    expect(
      column.links.some((l) => l.href === vk.href),
      'адрес, лежащий вне подвала, попал в измерение половины «присутствует»',
    ).toBe(false);
  });

  /**
   * Сценарий «снятая сеть вернулась»: половина «отсутствует» мерится по ВСЕЙ странице, и
   * подвал ей не граница. Проба ставится вне подвала намеренно — задача 5.2 требует именно
   * этого, иначе новую проверку не отличить от старой.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ.
   */
  it('снятая сеть обнаруживается вне подвала', () => {
    const html =
      '<html><body><main><a href="https://www.instagram.com/ikpk812/">мы в инстаграме</a></main>' +
      '<footer><div><h2>Подписывайтесь</h2><ul></ul></div></footer></body></html>';
    expect(
      retiredMentions(html).map((m) => `${m.name}:${m.where}`),
      'возврат снятой сети вне подвала не обнаружен',
    ).toEqual(['Instagram:ссылка']);

    const clean = '<html><body><footer><div><h2>Подписывайтесь</h2><ul></ul></div></footer></body></html>';
    expect(retiredMentions(clean), 'проверка нашла снятую сеть там, где её нет').toEqual([]);
  });
});

describe('состав внешних аккаунтов: покрыта каждая роль артефакта обязательного прогона', () => {
  /**
   * Сценарий «каждая роль проверена своим артефактом».
   *
   * Роли НЕ ПЕРЕЧИСЛЕНЫ здесь константой: перечень имён устареет при добавлении четвёртой
   * сборки, а отношение — нет. Состав выводится из репозитория: какой workflow публикует
   * сайт → о завершении какого workflow он ждёт события → какие сборки этот workflow
   * запускает → в какой каталог и с какой ролью пишет каждая (по скриптам `package.json`).
   *
   * ПОЧЕМУ КРАСНЫЙ СЕЙЧАС: обязательный прогон собирает три артефакта — боевой, демо и
   * стенд, — а проверку состава по выводу до этого change не исполняла ни одна, и шаг,
   * прогоняющий проверку роли стенда, в обязательном прогоне ещё не заведён.
   *
   * Каталоги вывода здесь НЕ НАЗВАНЫ ни литералом, ни в обратных кавычках, и это не
   * стилистика: `tests/demo-gate.test.ts` определяет предмет проверки по объявленным ею
   * каталогам, и файл, назвавший два корня сразу, объявляется получившим два предмета.
   * Перечень каталогов эта проверка выводит из `package.json` во время прогона.
   */
  it('у каждой сборки обязательного прогона есть своя проверка состава, исполняемая в том же джобе', () => {
    const all = loadWorkflows();
    const gating = gatingWorkflows(all);
    expect(gating.length, 'не найдено ни одного workflow, требуемого для публикации').toBeGreaterThan(0);

    const scripts = (
      JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    expect(scripts, 'в web/package.json нет ни одного скрипта — выводить роли не из чего').toBeTruthy();

    /** Сборки вывода: имя npm-скрипта → каталог и роль. Роль читается из самого скрипта. */
    const builds = new Map<string, { outDir: string; role: string }>();
    for (const [name, body] of Object.entries(scripts!)) {
      if (!/\bastro build\b/.test(body)) continue;
      const outDir = body.match(/--outDir\s+(\S+)/)?.[1] ?? 'dist';
      const role = body.match(/\bPAYMENT_ROLE=(\S+)/)?.[1] ?? 'ci';
      builds.set(name, { outDir, role });
    }
    expect([...builds.keys()].sort(), 'сборок вывода в package.json не найдено').not.toEqual([]);

    /** Джобы обязательного прогона: имя → текст всех его команд. */
    const jobs = new Map<string, string>();
    for (const wf of gating) {
      for (const job of Object.values(wf.jobs)) {
        jobs.set(`${wf.displayName}/${job.key}`, job.steps.map((s) => s.run ?? '').join('\n'));
      }
    }

    const configs = vitestConfigs();
    const offenders: string[] = [];
    const covered: string[] = [];

    for (const [script, { outDir, role }] of builds) {
      // Сборка, которой обязательный прогон не делает, требования не касается: покрывать
      // надо роли, СОБИРАЕМЫЕ этим прогоном, а не все, что есть в package.json.
      const building = [...jobs].filter(([, runs]) =>
        new RegExp(`npm run ${script}(?![\\w:-])`).test(runs),
      );
      if (building.length === 0) continue;

      const checks = readdirSync(TESTS_DIR).filter(
        (f) =>
          /^social-accounts-.*\.test\.ts$/.test(f) &&
          new RegExp(`'${outDir}'`).test(readFileSync(join(TESTS_DIR, f), 'utf-8')),
      );
      if (checks.length !== 1) {
        offenders.push(
          `сборка '${script}' пишет в '${outDir}', а проверок состава для этого каталога ` +
            `${checks.length} (нужна ровно одна; найдено: ${checks.join(', ') || 'ничего'})`,
        );
        continue;
      }
      const check = checks[0]!;
      const text = readFileSync(join(TESTS_DIR, check), 'utf-8');
      if (!new RegExp(`role:\\s*'${role}'`).test(text)) {
        offenders.push(`${check}: не объявляет ожидаемой роли '${role}' сборки '${script}'`);
        continue;
      }
      const config = configs.find((c) => c.include.includes(`tests/${check}`));
      if (config === undefined) {
        offenders.push(`${check}: не выбран ни одной конфигурацией vitest — не исполняется нигде`);
        continue;
      }
      // Конфигурация обязана запускаться в ТОМ ЖЕ джобе, где артефакт собран: между
      // джобами рабочее дерево не переносится, и проверка в чужом джобе упала бы на
      // «предмета нет» — либо, что хуже, прошла бы по чужому выводу.
      const sameJob = building.filter(([, runs]) => runs.includes(config.file));
      if (sameJob.length === 0) {
        offenders.push(
          `${config.file} не запускается ни в одном джобе, который собирает '${outDir}' ` +
            `(собирают: ${building.map(([name]) => name).join(', ')})`,
        );
        continue;
      }
      covered.push(`${role} → ${outDir} → ${check} (${sameJob.map(([name]) => name).join(', ')})`);
    }

    expect(
      offenders,
      `роль артефакта обязательного прогона не проверена своим предметом:\n${offenders.join('\n')}`,
    ).toEqual([]);
    // Пустое покрытие прошло бы сверку с пустым перечнем нарушений — это провал, а не успех.
    expect(
      covered.length,
      'ни одна сборка обязательного прогона не сопоставлена проверке состава',
    ).toBeGreaterThan(0);
    expect(
      covered.length,
      `покрыто ролей: ${covered.length}, а сборок в обязательном прогоне больше:\n${covered.join('\n')}`,
    ).toBe(
      [...builds].filter(([script]) =>
        [...jobs.values()].some((runs) => new RegExp(`npm run ${script}(?![\\w:-])`).test(runs)),
      ).length,
    );
  });
});

function gatingWorkflows(all: Workflow[]): Workflow[] {
  const publishing = publishingWorkflows(all);
  const required = new Set(publishing.flatMap((wf) => workflowRunTrigger(wf)?.workflows ?? []));
  return all.filter((wf) => required.has(wf.displayName));
}

function vitestConfigs(): Array<{ file: string; include: string[] }> {
  const files = readdirSync(WEB_ROOT).filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f));
  expect(files, 'конфигураций vitest не найдено — выбирать проверки нечем').not.toEqual([]);
  return files.map((file) => {
    const text = readFileSync(join(WEB_ROOT, file), 'utf-8');
    const block = text.match(/include:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const include = [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    return { file, include };
  });
}

describe('отличимость Youtube и Rutube: порог цветового расстояния объявлен и различает цвета', () => {
  /**
   * Сценарий «контрольная пара не проходит порог».
   *
   * ПРЕЖНИЙ ДЕФЕКТ СПЕКИ ЗАКРЫТ. Первая редакция требования велела объявить порог и
   * подтвердить его контрольной парой, не называя ни метрику, ни способ получения пары, —
   * тогда подтверждение получалось по построению (для любого положительного порога
   * найдётся достаточно близкая пара). Это был ДЕФЕКТ-4 разбора
   * (`docs/handoff/social-accounts-spec-executability.md`). Нынешняя редакция называет и
   * метрику (ΔE76 в CIE Lab, D65), и правило пары — фиксированный якорь `#ff0000` и тот же
   * цвет с каждым каналом ×0,8 (`design.md`, Решение 19). Решением исполнителя осталось
   * только ЧИСЛО порога, и это спека допускает прямо.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — свойство самого порога, а не продукта.
   */
  it('контрольная пара из двух оттенков одного цвета порог не проходит', () => {
    const distance = deltaE76(CONTROL_PAIR.a, CONTROL_PAIR.b);
    expect(
      distance,
      `контрольная пара ${JSON.stringify(CONTROL_PAIR)} даёт расстояние ${distance.toFixed(1)}, ` +
        `то есть проходит порог ${COLOR_DISTANCE_THRESHOLD} — порог дефектен`,
    ).toBeLessThan(COLOR_DISTANCE_THRESHOLD);
  });

  /**
   * Контрольная пара получена НАЗВАННЫМ ПРАВИЛОМ, а не подобрана.
   *
   * Проверка стоит отдельно от предыдущей, и это не дублирование: та говорит «пара порог не
   * проходит» и была бы зелёной для ЛЮБОЙ достаточно близкой пары — включая подобранную под
   * удобный порог. Именно эту лазейку требование и закрывает, фиксируя якорь и множитель, а
   * значит проверять надо и происхождение пары, а не только её расстояние.
   *
   * Якорь сверяется с ЧИСЛОМ из требования (`#ff0000`), а не со «цветом одной из сетей»:
   * правило «фирменный цвет ×0,8» было дефектом промежуточной редакции — у тёмного цвета
   * оно даёт почти нулевое расстояние, и подтверждение снова получалось бы по построению.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — свойство объявленной пары, а не продукта.
   */
  it('контрольная пара выведена из фиксированного якоря по правилу требования', () => {
    expect(CONTROL_ANCHOR, 'якорь контрольной пары не равен названному требованием #ff0000').toEqual([
      255, 0, 0,
    ]);
    expect(CONTROL_PAIR.a, 'первый цвет пары не равен якорю').toEqual(CONTROL_ANCHOR);
    expect(
      CONTROL_PAIR.b,
      `второй цвет пары не равен якорю с каналами ×${CONTROL_PAIR_FACTOR} — пара подобрана, а не выведена`,
    ).toEqual(CONTROL_ANCHOR.map((c) => Math.round(c * CONTROL_PAIR_FACTOR)));
    expect(
      CONTROL_PAIR_FACTOR,
      'множитель канала не равен названному требованием 0,8',
    ).toBeCloseTo(0.8, 10);
  });

  /** Порог, который не проходит ничто, тоже ничего не измеряет: нужна пара, его проходящая. */
  it('порог проходим — иначе он не признак, а запрет', () => {
    const black = [0, 0, 0];
    const white = [255, 255, 255];
    expect(
      deltaE76(black, white),
      'порог не проходит даже чёрное против белого — он не различает цвета, а запрещает всё',
    ).toBeGreaterThan(COLOR_DISTANCE_THRESHOLD);
  });
});

describe('реестр применимости марок: запись читается автоматикой, а не человеком', () => {
  const NETWORKS = ACCEPTED_ACCOUNTS.map((a) => a.name);

  /** Полная запись об одной сети. Придуманная — предмет здесь правило, а не чей-то выбор. */
  function entry(over: Partial<MarkRegistryEntry> & { network: string }): MarkRegistryEntry {
    return {
      outcome: 'mark',
      decidedAt: '2026-08-24',
      conditionsSource: 'https://example.invalid/brand-guidelines',
      conditionsOutcome: 'размещение в подвале сайта разрешено',
      markFileHash: 'sha256-0000000000000000000000000000000000000000000000000000000000000000',
      ...over,
    };
  }

  /** Полный реестр по всем четырём сетям — база, от которой мутируют отдельные проверки. */
  function fullRegistry(): MarkRegistryEntry[] {
    return NETWORKS.map((network) => entry({ network }));
  }

  /**
   * Сценарий «полная запись определяет исход».
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — правило прочтения записи, и оно написано здесь же.
   * Свидетельство для него — не красный прогон, а то, что соседние проверки на неполной и
   * отсутствующей записи дают ДРУГОЙ ответ: правило, отвечающее одинаково на любой вход,
   * ничего не определяет.
   *
   * Проверяются ОБА исхода, а не один: предикат, который на `text-link` отвечал бы так же,
   * как на `mark`, прошёл бы проверку одного исхода и не выделял бы законное исключение —
   * то есть ровно то, ради чего реестр и заведён.
   */
  it('полная запись определяет исход, и оба исхода различимы', () => {
    const registry = fullRegistry();
    registry[2] = entry({ network: NETWORKS[2]!, outcome: 'text-link', markFileHash: undefined });

    expect(markDecision(registry, NETWORKS[0]!).outcome, 'полная запись с исходом mark не прочитана').toBe(
      'mark',
    );
    expect(
      markDecision(registry, NETWORKS[2]!).outcome,
      'полная запись с исходом text-link не прочитана',
    ).toBe('text-link');

    // Сценарий «марка сети показана» после сужения: обязаны нести марку все, КРОМЕ сети с
    // исходом text-link. Проверка «все четыре» объявила бы нарушением законный выбор владельца.
    expect(
      networksRequiringMark(registry, NETWORKS),
      'перечень сетей, обязанных нести марку, не исключил законную текстовую ссылку',
    ).toEqual(NETWORKS.filter((_, i) => i !== 2));

    expect(
      networksWithoutDecision(registry, NETWORKS),
      'при полном реестре сетей без решения быть не должно',
    ).toEqual([]);
  });

  /**
   * Сценарий «запись неполна»: сеть считается не имеющей решения, и её подача не считается
   * выполненной. Проверяются ВСЕ входы неполноты по отдельности, а не один: спека называет
   * прямо два (нет источника условий, нет даты), состав полей — остальные, и непройденная
   * ветка предиката — такое же обещание, как непроверенный гейт.
   *
   * `markFileHash` в перечне не случайно: без независимо зафиксированного хеша сверка
   * «файл марки совпадает с первоисточником» сравнивала бы файл сам с собой (Решение 17).
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ.
   */
  it('неполная запись равнозначна отсутствию решения — по каждому обязательному полю', () => {
    const target = NETWORKS[0]!;
    const holes: Array<keyof MarkRegistryEntry> = [
      'decidedAt',
      'conditionsSource',
      'conditionsOutcome',
      'markFileHash',
    ];
    const survived: string[] = [];
    for (const field of holes) {
      const registry = fullRegistry();
      registry[0] = entry({ network: target, [field]: undefined });
      const decision = markDecision(registry, target);
      if (decision.outcome !== null) survived.push(`${String(field)} → ${decision.outcome}`);
      else if (!decision.why.includes(String(field))) {
        survived.push(`${String(field)} → причина не называет поле: ${decision.why}`);
      }
    }
    expect(
      survived,
      `запись без обязательного поля принята за решение либо причина не названа:\n${survived.join('\n')}`,
    ).toEqual([]);

    // Пустая строка — тоже отсутствие: поле, заполненное пробелом, требованию не удовлетворяет,
    // а признак «ключ присутствует» его бы принял.
    const blank = fullRegistry();
    blank[0] = entry({ network: target, conditionsSource: '   ' });
    expect(markDecision(blank, target).outcome, 'поле из пробелов принято за источник условий').toBeNull();

    // Исход вне двух допустимых значений — тоже отсутствие решения: поле бинарно (Решение 18),
    // и третье значение было дефектом первой редакции требования.
    const third = fullRegistry();
    third[0] = { ...entry({ network: target }), outcome: 'alternative' as unknown as 'mark' };
    expect(markDecision(third, target).outcome, 'третье значение исхода принято за решение').toBeNull();
  });

  /**
   * Сценарий «записи о сети нет вовсе»: равнозначно неполной записи.
   *
   * Проверяется и то, что такая сеть ОСТАЁТСЯ в перечне обязанных нести марку: «реестр не
   * называет исход text-link» — а он его не называет, значит требование о марке действует.
   * Обратное прочтение («нет записи — значит и требования нет») превратило бы потерянную
   * запись в разрешение не показывать марку.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ.
   */
  it('отсутствие записи о сети равнозначно неполной записи', () => {
    const missing = NETWORKS[3]!;
    const registry = fullRegistry().filter((e) => e.network !== missing);

    expect(markDecision(registry, missing).outcome, 'сеть без записи получила исход').toBeNull();
    expect(
      networksWithoutDecision(registry, NETWORKS).map((n) => n.network),
      'сеть без записи не названа среди не имеющих решения',
    ).toEqual([missing]);
    expect(
      networksRequiringMark(registry, NETWORKS),
      'сеть без записи выпала из перечня обязанных нести марку — потеря записи стала разрешением',
    ).toEqual(NETWORKS);

    // Две записи об одной сети — тоже отсутствие решения: спека говорит о записи в
    // единственном числе, а проверка, молча берущая первую, выбирала бы за читателя.
    const twice = [...fullRegistry(), entry({ network: NETWORKS[0]!, outcome: 'text-link' })];
    expect(markDecision(twice, NETWORKS[0]!).outcome, 'из двух записей о сети выбрана одна молча').toBeNull();

    // Реестр, которого нет вовсе или который отдаёт не перечень, — то же состояние, а не
    // «нарушений нет»: иначе отсутствие файла читалось бы как отсутствие требований.
    for (const shape of [undefined, null, {}, 'записи в прозе']) {
      expect(
        networksWithoutDecision(shape, NETWORKS).length,
        `реестр вида ${JSON.stringify(shape) ?? 'undefined'} принят за источник решений`,
      ).toBe(NETWORKS.length);
    }
  });

  /**
   * Сценарий «текстом осталось больше одной сети» (Requirement «Аккаунт обозначается
   * официальной маркой»): порог полноты. Одна текстовая ссылка требование НЕ нарушает —
   * проверяются обе стороны, иначе предикат «есть хоть одна текстовая» прошёл бы проверку
   * одной стороны и запрещал бы законный выбор владельца.
   *
   * ЗЕЛЁНЫЙ ПО ЗАМЫСЛУ: предмет — сам порог. Содержательным он станет только после
   * появления реестра с настоящими решениями.
   */
  it('порог полноты: одна текстовая ссылка законна, две — подача не выполнена', () => {
    const one = fullRegistry();
    one[1] = entry({ network: NETWORKS[1]!, outcome: 'text-link', markFileHash: undefined });
    expect(textLinkOverflow(one, NETWORKS), 'одна текстовая ссылка объявлена нарушением порога').toEqual(
      [],
    );

    const two = fullRegistry();
    two[1] = entry({ network: NETWORKS[1]!, outcome: 'text-link', markFileHash: undefined });
    two[3] = entry({ network: NETWORKS[3]!, outcome: 'text-link', markFileHash: undefined });
    expect(
      textLinkOverflow(two, NETWORKS),
      'две текстовые ссылки не признаны переходом порога полноты',
    ).toEqual([NETWORKS[1], NETWORKS[3]]);
  });

  /**
   * МЕТА-ГЕЙТ: браузерная проверка обязана начать читать реестр в тот момент, когда реестр
   * появится.
   *
   * Зачем он нужен. Реестра сегодня нет — его создаёт реализация (Решение 18), — поэтому
   * `footer-social.spec.ts` требует марку от всех четырёх сетей. Это не обход требования, а
   * то же требование, вычисленное на текущем состоянии реестра: пустой реестр ни для одной
   * сети не называет исход `text-link`, значит марку обязаны нести все четыре. Но как только
   * реестр появится и владелец законно оставит одну сеть текстом, та же проверка объявит
   * законный выбор нарушением — и её ослабят.
   *
   * Почему мета-гейт, а не чтение реестра браузерной проверкой уже сейчас. Литеральный
   * импорт несуществующего модуля роняет `typecheck` (измерено на этом дереве: `ts(2307)`,
   * 1 error из 289 файлов), а импорт по вычисленному спецификатору `typecheck` проходит
   * (0 errors) — но создаёт ветвь, которую сегодня НЕЧЕМ пройти: загружать нечего, и под
   * загрузчиком Playwright она не проверена вовсе. Непройденная ветвь — такое же обещание,
   * как непроверенный гейт, поэтому вместо обещания в комментарии здесь стоит проверка,
   * которая покраснеет сама.
   *
   * ЗЕЛЁНЫЙ ВАКУУМНО, и это названо вслух: пока модуля нет, требовать нечего. Его
   * свидетельство — негативная мутация «создать модуль», после которой проверка обязана
   * покраснеть; сама по себе она сейчас ничего не подтверждает.
   */
  it('как только реестр появится, браузерная проверка обязана его читать', () => {
    const registryModule = join(SRC_ROOT, 'lib', 'social-marks-registry.ts');
    if (!existsSync(registryModule)) return;

    const spec = join(TESTS_DIR, 'footer-social.spec.ts');
    expect(existsSync(spec), 'нет браузерной проверки подачи — предмет мета-гейта исчез').toBe(true);
    const code = stripComments(readFileSync(spec, 'utf-8'));
    expect(
      /social-marks-registry|networksRequiringMark/.test(code),
      'реестр применимости появился, а браузерная проверка подачи по-прежнему требует марку ' +
        'от всех четырёх сетей — законный выбор владельца она объявит нарушением. Проверку ' +
        'надо сузить до перечня networksRequiringMark(...) (Requirement «Решение о применимости ' +
        'марки зафиксировано в машиночитаемом реестре»)',
    ).toBe(true);
  });
});
