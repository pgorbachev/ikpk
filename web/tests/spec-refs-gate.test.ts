import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Тесты на сам гейт ссылок `bin/check-spec-refs`.
 *
 * Зачем: гейт входит в обязательные проверки ветки, то есть его ложный вердикт останавливает
 * merge или пропускает дефект. При этом ревью нашло у него четыре ветви, которые не проходил
 * ни один вход на реальном дереве — а непройденная ветвь такое же обещание, как непроверенный
 * гейт. Здесь каждая ветвь получает свой вход.
 *
 * Метод: синтетический репозиторий в каталоге временных файлов. Настоящее дерево для этого не
 * годится — на нём нельзя создать ни неоднозначность, ни битый реестр, не сломав его самого.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE = join(REPO_ROOT, 'bin', 'check-spec-refs');

let sandbox: string;

/** Создаёт минимальный репозиторий: один файл кода, один артефакт спеки, два пустых реестра. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-refs-gate-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'web', 'src'), { recursive: true });
  mkdirSync(join(dir, 'openspec', 'specs', 'demo'), { recursive: true });
  mkdirSync(join(dir, 'openspec', 'changes', 'demo-change'), { recursive: true });
  cpSync(GATE, join(dir, 'bin', 'check-spec-refs'));
  // Заглушка CLI OpenSpec: гейт спрашивает у него состав артефактов схемы. Настоящий вызов —
  // это `npx`, то есть сеть; в тесте нужен детерминированный ответ, а не проверка npm. Формат
  // ответа взят с реального `./bin/openspec status --json`.
  writeFileSync(
    join(dir, 'bin', 'openspec'),
    [
      '#!/bin/sh',
      'cat <<JSON',
      '{"schemaName":"spec-driven","artifactPaths":{',
      '  "proposal": {"resolvedOutputPath": "/x/proposal.md"},',
      '  "design": {"resolvedOutputPath": "/x/design.md"},',
      '  "tasks": {"resolvedOutputPath": "/x/tasks.md"},',
      '  "specs": {"resolvedOutputPath": "/x/specs/**/*.md"}',
      '}}',
      'JSON',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'web', 'src', 'thing.ts'), 'export const marker = 1;\nconst second = 2;\n');
  writeFileSync(
    join(dir, 'openspec', 'changes', 'demo-change', '.openspec.yaml'),
    'schema: spec-driven\n',
  );
  for (const name of ['proposal.md', 'design.md', 'tasks.md']) {
    writeFileSync(join(dir, 'openspec', 'changes', 'demo-change', name), `# ${name}\n`);
  }
  writeFileSync(join(dir, 'openspec', '.spec-ref-debt'), '# пусто\n');
  writeFileSync(join(dir, 'openspec', '.spec-ref-absent'), '# пусто\n');
  writeFileSync(join(dir, 'openspec', 'specs', 'demo', 'spec.md'), '## P\n\nСтартовое состояние.\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  // Достижимость ревизий гейт мерит по `refs/remotes/origin/*`, а не по локальной базе объектов
  // (иначе локальный и CI-вердикт расходятся). Значит песочница обязана иметь настоящий origin —
  // иначе тесты проверяли бы поведение, которого в жизни не бывает.
  const originDir = `${dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', originDir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originDir]);
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin']);
  return dir;
}

/** Кладёт текст в артефакт принятой спеки и возвращает вердикт гейта. */
function run(dir: string, specBody: string): { code: number; out: string } {
  writeFileSync(join(dir, 'openspec', 'specs', 'demo', 'spec.md'), specBody);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'state', '--allow-empty']);
  // Состояние публикуется в origin: ссылка на ревизию считается проверяемой только если ревизия
  // достижима из общего репозитория.
  execFileSync('git', ['-C', dir, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin']);
  const r = spawnSync(join(dir, 'bin', 'check-spec-refs'), { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Пишет текст в артефакт CHANGE (а не принятой спеки) и возвращает вердикт. Нужен потому, что
 *  проверка коротких имён артефактов схемы срабатывает только внутри `openspec/changes/**`, и без
 *  такого входа её можно было отключить, не уронив ни один тест. */
function runInChange(dir: string, body: string): { code: number; out: string } {
  writeFileSync(join(dir, 'openspec', 'changes', 'demo-change', 'tasks.md'), body);
  return run(dir, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
}

/**
 * Ревизия, достижимая в origin ТОЛЬКО через ветку, не являющуюся предком `origin/main`. Именно
 * этот класс ссылок гейт до четвёртого круга ревью не проверял вовсе: она достижима сегодня и
 * исчезает в день уборки чужой ветки, роняя обязательную проверку на всех PR сразу. Обычная
 * песочница такого входа не даёт — `run()` публикует состояние прямо в `main`.
 */
function makeBranchOnlyRevision(dir: string, marker: string): string {
  const back = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-B', 'side']);
  writeFileSync(
    join(dir, 'web', 'src', 'thing.ts'),
    `export const marker = 1;\nconst second = 2;\nconst ${marker} = 3;\n`,
  );
  execFileSync('git', ['-C', dir, 'commit', '-q', '-am', `side ${marker}`]);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', dir, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/side']);
  execFileSync('git', ['-C', dir, 'checkout', '-q', back]);
  execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin']);
  return sha;
}

// Лимит хука задан явно: `makeRepo()` делает `git init`, коммит, bare-origin, push и fetch, и под
// нагрузкой (полный прогон рядом с другими файлами) не укладывается в стандартные 10 секунд —
// измерено дважды, файл падал целиком с «Hook timed out», а 67 проверок уходили в skipped. Это
// покраснение БЕЗ дефекта: «не смогла измерить», выданное за «нашла проблему», только в обратную
// сторону — обязательная проверка встаёт, а причина не в предмете.
beforeAll(() => {
  sandbox = makeRepo();
}, 60_000);

/**
 * Каждая проверка начинается с чистого состояния. Без этого падение одной проверки уносило
 * восстановление файлов в её конце, и следующие падали каскадом по чужой причине — то есть
 * атрибуция ломалась ровно там, где она и нужна.
 */
beforeEach(() => {
  writeFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), '# пусто\n');
  writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  for (const stray of [
    join(sandbox, 'web', 'other'),
    join(sandbox, 'web', 'dist'),
    join(sandbox, 'web', 'package.json'),
    join(sandbox, '.gitignore'),
  ]) {
    rmSync(stray, { recursive: true, force: true });
  }
  writeFileSync(join(sandbox, 'web', 'src', 'thing.ts'), 'export const marker = 1;\nconst second = 2;\n');
  // Артефакты демо-change тоже сбрасываются: тест, писавший в `tasks.md`, оставлял свою ссылку
  // всем последующим — одна запись класса «проза» протекала в десять проверок и ломала их по
  // чужой причине. Ровно та же ошибка атрибуции, из-за которой в этом файле появился `beforeEach`.
  writeFileSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'tasks.md'), '# tasks.md\n');
  rmSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'specs'), { recursive: true, force: true });
  rmSync(join(sandbox, 'openspec', 'changes', 'archive'), { recursive: true, force: true });
  // Сброс КОММИТИТСЯ, иначе он живёт только в рабочем дереве: `git checkout -B side` внутри
  // `makeBranchOnlyRevision` восстанавливает файлы из коммита и возвращает чужую ссылку обратно.
  // Утечка между тестами шла именно через историю, а не через диск — по одному прогону это
  // выглядело как «тест зависит от порядка», хотя причина в неполном сбросе.
  execFileSync('git', ['-C', sandbox, 'add', '-A']);
  execFileSync('git', ['-C', sandbox, 'commit', '-q', '-m', 'reset', '--allow-empty']);
});

afterAll(() => {
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(`${sandbox}-origin.git`, { recursive: true, force: true });
  }
});

describe('гейт ссылок: исходы по классам', () => {
  it('верная ссылка с фрагментом — код 0', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:1`, `export const marker`.\n');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/содержимое сверено у 1/);
  });

  it('фрагмент из одного идентификатора тоже считается фрагментом', () => {
    // Ревью нашло, что фрагмент вида `marker` (без пробелов) отбрасывался как «похожий на
    // путь», и гейт требовал фрагмент, который уже написан.
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/содержимое сверено у 1/);
  });

  it('фрагмент перед ссылкой тоже считается фрагментом', () => {
    const r = run(sandbox, '## Purpose\n\nЗдесь `marker`, `web/src/thing.ts:1` — так тоже пишут.\n');
    expect(r.code, r.out).toBe(0);
  });

  it('устаревший фрагмент — код 1 и показ фактической строки', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:2`, `export const marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/фрагмент/);
    expect(r.out).toMatch(/const second/);
  });

  it('номер строки за концом файла — код 1', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:99`, `export const marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/в файле \d+ строк/);
  });

  it('номер строки 0 и вывернутый диапазон — код 1, а не «неизмеримо»', () => {
    expect(run(sandbox, '## P\n\n`web/src/thing.ts:0`, `marker`.\n').code).toBe(1);
    const r = run(sandbox, '## P\n\n`web/src/thing.ts:9-2`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/не существует/);
  });

  it('несуществующий путь без объявления — код 1', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/no-such.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/путь не существует/);
  });

  it('ссылка за пределы репозитория — код 1', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `../../etc/passwd:1`, `root`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/за пределы репозитория/);
  });

  it('осиротевший номер строки — код 1', () => {
    const r = run(sandbox, '## Purpose\n\nПросто номер: `:273` без пути.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/номер строки без пути/);
  });

  it('продолжение наследует путь предыдущей ссылки', () => {
    const r = run(
      sandbox,
      '## Purpose\n\nСсылка: `web/src/thing.ts:1`, `marker` и `:2`, `const second`.\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/содержимое сверено у 2/);
  });

  it('ссылки внутри блока кода не проверяются', () => {
    // Верная ссылка снаружи блока нужна, чтобы дерево не оказалось «без ссылок вовсе»: этот
    // случай гейт отдельно объявляет неизмеримым (код 2), и он проверяется следующим тестом.
    const r = run(
      sandbox,
      '## Purpose\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n\nПример неверной формы:\n\n```\n`web/src/no-such.ts:1`\n```\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/содержимое сверено у 1/);
  });

  it('артефакты без единой ссылки — код 2, а не «ссылки верны»', () => {
    const r = run(sandbox, '## Purpose\n\nТекст без ссылок.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/не нашлось ни одной проверяемой ссылки/);
  });

  it('ссылка на каталог с номером строки — код 1', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/:5`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/у каталога не бывает строки/);
  });

  it('ссылка, привязанная к ревизии, читается из этой ревизии', () => {
    const head = execFileSync('git', ['-C', sandbox, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    // Меняем файл так, чтобы на HEAD фрагмента на первой строке уже не было.
    writeFileSync(join(sandbox, 'web', 'src', 'thing.ts'), '// сдвиг\nexport const marker = 1;\n');
    const r = run(sandbox, `## Purpose\n\nСсылка: \`web/src/thing.ts@${head}:1\`, \`export const marker\`.\n`);
    expect(r.code, r.out).toBe(0);
    // А та же ссылка без привязки к ревизии на новом состоянии обязана покраснеть.
    const r2 = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:1`, `export const marker`.\n');
    expect(r2.code, r2.out).toBe(1);
  });

  it('несуществующая ревизия — код 1, а не «файл в одну строку»', () => {
    const r = run(
      sandbox,
      '## Purpose\n\nСсылка: `web/src/thing.ts@0123456789abcdef0123456789abcdef01234567:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/не достижима ни из одного refs\/remotes\/origin/);
  });

  it('пустые реестры при нуле неизмеримых — код 0', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts`.\n');
    expect(r.code, r.out).toBe(0);
  });

  it('нет файла реестра — код 2, «не смогла измерить»', () => {
    rmSync(join(sandbox, 'openspec', '.spec-ref-debt'));
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts`.\n');
    expect(r.code, r.out).toBe(2);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), '# пусто\n');
  });

  it('запись реестра отсутствующих без причины — код 2', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/no-such.ts\n',
    );
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/no-such.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/причина обязательна/i);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('объявленная с причиной ссылка в пустоту — код 0', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/no-such.ts :: will-create\n',
    );
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/no-such.ts`.\n');
    expect(r.code, r.out).toBe(0);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('ответ CLI без artifactPaths — код 2, а не тихое отключение проверки', () => {
    const stub = join(sandbox, 'bin', 'openspec');
    const saved = readFileSync(stub, 'utf8');
    writeFileSync(stub, '#!/bin/sh\necho \'{"schemaName":"spec-driven"}\'\n', { mode: 0o755 });
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/artifactPaths/);
    writeFileSync(stub, saved, { mode: 0o755 });
  });

  it('CLI недоступен — код 2', () => {
    const stub = join(sandbox, 'bin', 'openspec');
    const saved = readFileSync(stub, 'utf8');
    writeFileSync(stub, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts`.\n');
    expect(r.code, r.out).toBe(2);
    writeFileSync(stub, saved, { mode: 0o755 });
  });

  it('недостижимая ревизия без объявления — код 1', () => {
    const r = run(
      sandbox,
      '## P\n\n`web/src/thing.ts@0123456789abcdef0123456789abcdef01234567:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/не достижима ни из одного refs\/remotes\/origin/);
  });

  it('недостижимая ревизия, объявленная как external-revision, merge не блокирует', () => {
    // Главная находка второго круга: прежний механизм кладл такую ссылку в храповик долга, и
    // «не блокирует» превращалось в «блокирует по росту долга».
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\n* :: 0123456789abcdef0123456789abcdef01234567 :: external-revision\n',
    );
    // Одного объявления мало: класс «вне общего репозитория» тоже поимённый — иначе одна строка
    // реестра открывала бы неограниченный класс непроверяемых ссылок.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/thing.ts@0123456789abcdef0123456789abcdef01234567:1\n',
    );
    const r = run(
      sandbox,
      '## P\n\n`web/src/thing.ts@0123456789abcdef0123456789abcdef01234567:1`, `marker`.\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/объявлено вне main/);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('форма «ветка@sha» без пути: недостижимая ревизия — код 1, объявленная — код 0', () => {
    const bad = run(
      sandbox,
      '## P\n\nФакт найден на `feat/whatever@0123456789abcdef0123456789abcdef01234567`, а ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(bad.code, bad.out).toBe(1);
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\n* :: 0123456789abcdef0123456789abcdef01234567 :: external-revision\n',
    );
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: feat/whatever@0123456789abcdef0123456789abcdef01234567\n',
    );
    const ok = run(
      sandbox,
      '## P\n\nФакт найден на `feat/whatever@0123456789abcdef0123456789abcdef01234567`, а ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(ok.code, ok.out).toBe(0);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('сокращённая ревизия — код 1, а не тихий пропуск', () => {
    const r = run(sandbox, '## P\n\n`web/src/thing.ts@45297b4:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/сокращённо/);
  });

  it('исчезнувшая запись долга — код 1 (обратная сверка храповика)', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/thing.ts:1\n',
    );
    const r = run(sandbox, '## P\n\n`web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/ЗАПИСИ ДОЛГА БОЛЬШЕ НЕ НАХОДЯТСЯ/);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), '# пусто\n');
  });

  it('устаревшее объявление отсутствующей ссылки — код 1', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/gone.ts :: will-create\n',
    );
    const r = run(sandbox, '## P\n\n`web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/БОЛЬШЕ НЕ ОТСУТСТВУЮТ/);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('повторяющийся ключ в реестре — код 2', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/gone.ts :: will-create\n' +
        'openspec/specs/demo/spec.md :: web/src/gone.ts :: deleted-deliberately\n',
    );
    const r = run(sandbox, '## P\n\n`web/src/gone.ts`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/повторяющиеся ключи/);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('причина external-revision у ключа по ПУТИ — код 2', () => {
    // Эта причина означает «материал вне main, ключ по ревизии». С путём в ключе она прежде
    // принималась и не проверялась НИЧЕМ: обратная сверка исключает все external-revision, а
    // поиск мёртвых смотрел только на форму `* ::`. То есть строка разрешала произвольную
    // ссылку в пустоту, и снять её было некому.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/gone.ts :: external-revision\n',
    );
    const r = run(sandbox, '## P\n\n`web/src/gone.ts`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/40 hex/);
  });

  it('неверный регистр пути — код 1 ИМЕННО по причине регистра, на любой ФС', () => {
    // Прежняя редакция утверждала `/регистр пути|путь не существует/`: на Linux-раннере (то есть
    // в CI, где гейт обязателен) `existsSync` даёт false, тест проходил ДРУГОЙ ветвью, а сама
    // ветвь `wrongCase` была недостижима. Регистр определяется по индексу git — вердикт больше
    // не зависит от файловой системы исполнителя.
    const r = run(sandbox, '## P\n\n`web/src/THING.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/регистр пути/);
  });

  it('неоднозначное короткое имя с номером строки — код 1', () => {
    mkdirSync(join(sandbox, 'web', 'other'), { recursive: true });
    writeFileSync(join(sandbox, 'web', 'other', 'thing.ts'), 'export const x = 1;\n');
    const r = run(sandbox, '## P\n\n`thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/неоднозначно/);
    rmSync(join(sandbox, 'web', 'other'), { recursive: true, force: true });
  });

  it('ссылка в сборочный вывод идёт в реестр и не зависит от наличия сборки', () => {
    writeFileSync(join(sandbox, 'web', 'package.json'), '{"name":"w","private":true}\n');
    // Перечень корней сборки сверяется с .gitignore целиком, поэтому в песочнице надо
    // игнорировать все корни, чьи пакеты объявлены, — иначе сработает та самая сверка.
    writeFileSync(join(sandbox, '.gitignore'), 'dist/\ndist-demo/\n');
    const body = '## P\n\nВывод: `web/dist/index.html`.\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n';
    const before = run(sandbox, body);
    expect(before.code, before.out).toBe(1);
    expect(before.out).toMatch(/сборочный вывод/);
    // Реестр принял запись — и теперь наличие сборки НЕ меняет вердикт.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/dist/index.html\n',
    );
    const clean = run(sandbox, body);
    expect(clean.code, clean.out).toBe(0);
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    writeFileSync(join(sandbox, 'web', 'dist', 'index.html'), '<html></html>\n');
    const built = run(sandbox, body);
    expect(built.code, built.out).toBe(0);
    rmSync(join(sandbox, 'web', 'dist'), { recursive: true, force: true });
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), '# пусто\n');
    rmSync(join(sandbox, 'web', 'package.json'));
    rmSync(join(sandbox, '.gitignore'));
  });

  it('перечень строк проверяется на попадание в файл', () => {
    const ok = run(sandbox, '## P\n\n`web/src/thing.ts:1,2`.\n');
    expect(ok.code, ok.out).toBe(1);
    expect(ok.out).toMatch(/перечень строк/);
    const bad = run(sandbox, '## P\n\n`web/src/thing.ts:1,999`.\n');
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toMatch(/в файле \d+ строк/);
  });

  it('слишком короткий фрагмент — не «сверено», а храповик', () => {
    const r = run(sandbox, '## P\n\n`web/src/thing.ts:1`, `ab`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/слишком короткий/);
  });

  it('тройная кавычка внутри строки не гасит участок', () => {
    const r = run(
      sandbox,
      '## P\n\nФорма `a```b` в прозе, затем `web/src/no-such.ts:1`, `нет`.\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/путь не существует/);
  });

  it('ни одного .openspec.yaml при наличии change — код 2', () => {
    const yml = join(sandbox, 'openspec', 'changes', 'demo-change', '.openspec.yaml');
    const saved = readFileSync(yml, 'utf8');
    rmSync(yml);
    const r = run(sandbox, '## P\n\n`web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/\.openspec\.yaml/);
    writeFileSync(yml, saved);
  });

  it('--write-absent сохраняет объявления по SHA, а не сносит их', () => {
    // Первая редакция режима записи их снесла, и ссылки на неслитые ветки мгновенно стали
    // расхождениями: реестр терял часть себя при штатной перезаписи, оставаясь на вид полным.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\n* :: 0123456789abcdef0123456789abcdef01234567 :: external-revision\n',
    );
    // На объявленный SHA обязана быть ссылка: мёртвое объявление гейт отклоняет отдельно.
    writeFileSync(
      join(sandbox, 'openspec', 'specs', 'demo', 'spec.md'),
      '## P\n\n`web/src/thing.ts:1`, `marker`.\n\nФакт на `feat/x@0123456789abcdef0123456789abcdef01234567`.\n',
    );
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: feat/x@0123456789abcdef0123456789abcdef01234567\n',
    );
    execFileSync('git', ['-C', sandbox, 'add', '-A']);
    execFileSync('git', ['-C', sandbox, 'commit', '-q', '-m', 's', '--allow-empty']);
    execFileSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-absent'], { cwd: sandbox });
    const after = readFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), 'utf8');
    expect(after).toMatch(/0123456789abcdef0123456789abcdef01234567 :: external-revision/);
  });

  it('без refs/remotes/origin достижимость ревизий не измеряется — код 2', () => {
    // Отсутствие origin-рефов — «не смогла измерить», а не «всё недостижимо». Отдельный
    // репозиторий: в основной песочнице origin есть по построению.
    const lonely = mkdtempSync(join(tmpdir(), 'spec-refs-lonely-'));
    execFileSync('git', ['init', '-q', lonely]);
    execFileSync('git', ['-C', lonely, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', lonely, 'config', 'user.name', 't']);
    mkdirSync(join(lonely, 'bin'), { recursive: true });
    mkdirSync(join(lonely, 'openspec', 'specs', 'demo'), { recursive: true });
    cpSync(join(sandbox, 'bin', 'check-spec-refs'), join(lonely, 'bin', 'check-spec-refs'));
    cpSync(join(sandbox, 'bin', 'openspec'), join(lonely, 'bin', 'openspec'));
    writeFileSync(join(lonely, 'openspec', '.spec-ref-debt'), '# пусто\n');
    writeFileSync(join(lonely, 'openspec', '.spec-ref-absent'), '# пусто\n');
    writeFileSync(join(lonely, 'openspec', 'specs', 'demo', 'spec.md'), '## P\n\nТекст.\n');
    execFileSync('git', ['-C', lonely, 'add', '-A']);
    execFileSync('git', ['-C', lonely, 'commit', '-q', '-m', 'init']);
    const r = spawnSync(join(lonely, 'bin', 'check-spec-refs'), { cwd: lonely, encoding: 'utf8' });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/refs\/remotes\/origin/);
    rmSync(lonely, { recursive: true, force: true });
  });

  it('удалённый артефакт схемы, на который ссылается change, — код 1', () => {
    // Эту ветвь можно было отключить (`SCHEMA_ARTIFACTS.has(path)` → false), и все 38 тестов
    // оставались зелёными: ни один не писал текст в артефакт change.
    const design = join(sandbox, 'openspec', 'changes', 'demo-change', 'design.md');
    const saved = readFileSync(design, 'utf8');
    rmSync(design);
    const r = runInChange(sandbox, '# tasks\n\nСм. `design.md`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/артефакт схемы не существует/);
    writeFileSync(design, saved);
    writeFileSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'tasks.md'), '# tasks.md\n');
  });

  it('--check-built: путь есть в собранном дереве — код 0, нет — код 1', () => {
    writeFileSync(join(sandbox, 'web', 'package.json'), '{"name":"w","private":true}\n');
    writeFileSync(join(sandbox, '.gitignore'), 'dist/\ndist-demo/\n');
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/dist/index.html\n',
    );
    const body = '## P\n\nВывод: `web/dist/index.html`.\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n';
    run(sandbox, body);
    const gate = join(sandbox, 'bin', 'check-spec-refs');
    // Корень собран, но названного файла в нём нет — расхождение. Отсутствие самого корня
    // расхождением больше не считается: это отдельный исход (код 2, «проверять нечего»), у него
    // свой тест — иначе вакуумный прогон гейта публикации выдавался бы за проверку.
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    const withoutBuild = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    expect(withoutBuild.status, `${withoutBuild.stdout}${withoutBuild.stderr}`).toBe(1);
    expect(`${withoutBuild.stdout}${withoutBuild.stderr}`).toMatch(/в собранном дереве пути нет/);
    writeFileSync(join(sandbox, 'web', 'dist', 'index.html'), '<html></html>\n');
    const withBuild = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    expect(withBuild.status, `${withBuild.stdout}${withBuild.stderr}`).toBe(0);
    expect(`${withBuild.stdout}${withBuild.stderr}`).toMatch(/проверен в собранном дереве/);
  });

  it('корень сборочного вывода перестал игнорироваться — код 2', () => {
    // Сверку перечня корней с .gitignore тоже можно было отключить без единого падения.
    writeFileSync(join(sandbox, 'web', 'package.json'), '{"name":"w","private":true}\n');
    writeFileSync(join(sandbox, '.gitignore'), 'nothing-relevant/\n');
    const r = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/перечень корней сборочного вывода/);
  });

  it('ссылка без номера строки и без фрагмента идёт в храповик, а не в «проверено»', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:1`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/номер строки без фрагмента/);
  });

  it('ревизия только на чужой ветке, форма «ref@sha» без объявления — код 1', () => {
    // Объявление требуется ЗАРАНЕЕ, пока ревизия достижима. Прежняя редакция описывала это
    // правилом в AGENTS.md, но не проверяла ничем: гейт узнавал о проблеме в тот день, когда
    // исправить ссылку было уже нечем — ревизия исчезала вместе с веткой.
    const sha = makeBranchOnlyRevision(sandbox, 'onSideA');
    const r = run(
      sandbox,
      `## P\n\nФакт найден на \`side@${sha}\`, а ссылка \`web/src/thing.ts:1\`, \`marker\`.\n`,
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/достижима только через/);
  });

  it('ревизия только на чужой ветке, форма «путь@sha»: без объявления — 1, с объявлением — 0', () => {
    const sha = makeBranchOnlyRevision(sandbox, 'onSideB');
    const body = `## P\n\nСсылка: \`web/src/thing.ts@${sha}:3\`, \`const onSideB\`.\n`;
    const bad = run(sandbox, body);
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toMatch(/достижима только через/);
    // Объявление по артефакту, а не через `*`: узкий ключ — то же требование поимённости.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      `# пусто\nopenspec/specs/demo/spec.md :: ${sha} :: external-revision\n`,
    );
    // Объявленная ссылка требует И строки реестра: членство в реестре определяется объявлением,
    // а не достижимостью, иначе удаление ветки создаёт новую запись и красит гейт.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      `# пусто\nopenspec/specs/demo/spec.md :: web/src/thing.ts@${sha}:3\n`,
    );
    const ok = run(sandbox, body);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toMatch(/объявлено заранее: 1/);
    // Пока ветка жива, содержимое именно сверяется, а не «принимается на слово».
    expect(ok.out).toMatch(/содержимое сверено у 1/);
  });

  it('объявление external-revision не по 40 hex — код 2 и в форме «артефакт :: sha»', () => {
    // Признак берётся по ПРИЧИНЕ, а не по написанию ключа: прежняя редакция требовала 40 hex
    // только при `* ::`, и строка с любым текстом вместо SHA принималась молча.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: ne-sha-vovse :: external-revision\n',
    );
    const r = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/40 hex/);
  });

  it('мёртвое объявление ревизии в форме «артефакт :: sha» — код 1', () => {
    // У этой формы не было ни одной проверки: поиск мёртвых смотрел только на `* ::`, а
    // обратная сверка исключает все external-revision целиком.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: 0123456789abcdef0123456789abcdef01234567 :: external-revision\n',
    );
    const r = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/МЁРТВЫЕ ОБЪЯВЛЕНИЯ РЕВИЗИЙ/);
  });

  it('форма «путь@sha» без номера строки: путь на ревизии есть — 0, нет — 1', () => {
    // Исправление этой ветви (прежде исключение и код 1) не имело регресс-теста: в наборе были
    // только `путь@sha:строка` и `ref@sha` без пути.
    const sha = execFileSync('git', ['-C', sandbox, 'rev-parse', 'refs/remotes/origin/main'], {
      encoding: 'utf8',
    }).trim();
    const good = run(sandbox, `## P\n\nСсылка: \`web/src/thing.ts@${sha}\`.\n`);
    expect(good.code, good.out).toBe(0);
    expect(good.out).toMatch(/существование пути/);
    const bad = run(sandbox, `## P\n\nСсылка: \`web/src/nope.ts@${sha}\`.\n`);
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toMatch(/нет пути/);
  });

  it('в клоне нет refs/remotes/origin/main — код 2', () => {
    // «Ревизия основной ветки» и «ревизия чужой ветки» — разные факты, и без основной ветки их
    // не различить. Это «не смогла измерить», а не «всё вне main»: иначе зеркало или форк с
    // другим именем основной ветки объявили бы дефектной каждую ссылку на ревизию.
    const dir = makeRepo();
    try {
      execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk']);
      execFileSync('git', ['-C', dir, 'push', '-q', 'origin', '--delete', 'main']);
      execFileSync('git', ['-C', dir, 'fetch', '-q', '--prune', 'origin']);
      const r = spawnSync(join(dir, 'bin', 'check-spec-refs'), { cwd: dir, encoding: 'utf8' });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status, out).toBe(2);
      expect(out).toMatch(/нет refs\/remotes\/origin\/main/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}-origin.git`, { recursive: true, force: true });
    }
  });

  it('опечатка в пути при форме «путь@sha» без строки — код 1, а не «только по ревизии»', () => {
    // Имя ветки и опечатка в пути неотличимы на глаз, но различимы измерением: первый сегмент
    // `web` существует в репозитории, значит записан путь. Ревью показало, что без этого класс
    // «только по ревизии» легализовал любую опечатку одной строкой реестра.
    const sha = execFileSync('git', ['-C', sandbox, 'rev-parse', 'refs/remotes/origin/main'], {
      encoding: 'utf8',
    }).trim();
    const r = run(sandbox, `## P\n\nФакт найден в \`web/src/lib/typo-here@${sha}\`.\n`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/нет пути/);
    expect(r.out).toMatch(/это записанный путь, а не имя ветки/);
  });

  it('--check-built без собранного дерева — код 2, а не зелёный', () => {
    // Вакуумный прогон режима, стоящего в гейте публикации, — «не выполнено», а не успех.
    const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--check-built'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(2);
    expect(out).toMatch(/нужно собранное дерево/);
  });

  it('--check-built= с корнем, которого нет или который вне перечня — код 2', () => {
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    const gate = join(sandbox, 'bin', 'check-spec-refs');
    // Корень взят НЕ демонстрационный намеренно. Гейт demo-gate.test.ts определяет предмет файла
    // по строковым литералам, и его разбор не отличает литерал от текста комментария: даже
    // упоминание демо-каталога в обратных кавычках ВНУТРИ комментария делало этот файл «проверкой
    // демо-вывода», после чего шаг обычных юнитов читался как проверка демо-сборки, стоящая раньше
    // самой сборки (измерено: четыре ложных срабатывания). Предмет этого теста от выбора корня не
    // зависит: cms/dist в перечне есть и в CI не собирается.
    const missing = spawnSync(gate, ['--check-built=cms/dist'], { cwd: sandbox, encoding: 'utf8' });
    expect(missing.status, `${missing.stdout}${missing.stderr}`).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toMatch(/названы собранными, но их нет/);
    const unknown = spawnSync(gate, ['--check-built=nope/dist'], { cwd: sandbox, encoding: 'utf8' });
    expect(unknown.status, `${unknown.stdout}${unknown.stderr}`).toBe(2);
    expect(`${unknown.stdout}${unknown.stderr}`).toMatch(/вне перечня сборочного вывода/);
  });

  it('--check-built не считает дефектом ссылку в НЕсобранный корень и говорит об этом вслух', () => {
    // Джоб собирает только web, а корней сборочного вывода четыре. Прежняя редакция объявляла
    // отсутствие дерева расхождением: законная ссылка на `cms/dist/**` валила гейт публикации.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: cms/dist/index.js\n',
    );
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    run(sandbox, '## P\n\nВывод CMS: `cms/dist/index.js`.\n');
    const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--check-built'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/cms\/dist в этом прогоне не собран — 1 ссылок туда НЕ проверено/);
  });

  it('--write-debt действительно пишет реестр', () => {
    // Ревью погасило запись файла целиком (`if (false) writeFileSync(...)`) — ни один тест не
    // упал: у режима не было входа вовсе.
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`.\n');
    const before = readFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), 'utf8');
    expect(before).not.toMatch(/thing\.ts:1/);
    spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-debt'], { cwd: sandbox });
    const after = readFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), 'utf8');
    expect(after).toMatch(/openspec\/specs\/demo\/spec\.md :: web\/src\/thing\.ts:1/);
  });

  it('--write-absent вписывает НОВУЮ запись с ТРЕБУЕТСЯ-ПРИЧИНА', () => {
    // Прежний тест этого режима сам писал проверяемую строку в файл, а затем утверждал, что она
    // в файле есть: с полностью отключённой записью утверждение оставалось верным.
    run(sandbox, '## P\n\nСсылка: `web/src/nope.ts`.\n');
    const before = readFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), 'utf8');
    expect(before).not.toMatch(/nope\.ts/);
    spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-absent'], { cwd: sandbox });
    const after = readFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), 'utf8');
    expect(after).toMatch(/web\/src\/nope\.ts :: ТРЕБУЕТСЯ-ПРИЧИНА/);
    // И такой файл гейт не принимает — иначе один прогон превращал красное в зелёное.
    const r = run(sandbox, '## P\n\nСсылка: `web/src/nope.ts`.\n');
    expect(r.code, r.out).toBe(2);
  });

  it('усечённый клон при ссылке на ревизию — код 2', () => {
    // Ветвь определения усечённого клона тоже гасилась без падений. «Ревизии нет» и «история не
    // выбрана» — разные факты: у actions/checkout по умолчанию fetch-depth 1.
    // Состояние с двумя коммитами: глубина 1 оставит в клоне только вершину, и ссылка на
    // ПРЕДЫДУЩУЮ ревизию окажется непроверяемой — ровно случай CI по умолчанию.
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    const parent = execFileSync('git', ['-C', sandbox, 'rev-parse', 'HEAD~1'], {
      encoding: 'utf8',
    }).trim();
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    const shallow = mkdtempSync(join(tmpdir(), 'spec-refs-shallow-'));
    rmSync(shallow, { recursive: true, force: true });
    execFileSync('git', [
      'clone', '-q', '--depth', '1', '--branch', 'main', `file://${sandbox}-origin.git`, shallow,
    ]);
    execFileSync('git', ['-C', shallow, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', shallow, 'config', 'user.name', 't']);
    writeFileSync(
      join(shallow, 'openspec', 'specs', 'demo', 'spec.md'),
      `## P\n\nСсылка: \`web/src/thing.ts@${parent}:1\`, \`marker\`.\n`,
    );
    try {
      const r = spawnSync(join(shallow, 'bin', 'check-spec-refs'), { cwd: shallow, encoding: 'utf8' });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const shallowFlag = execFileSync('git', ['-C', shallow, 'rev-parse', '--is-shallow-repository'], {
        encoding: 'utf8',
      }).trim();
      expect(shallowFlag).toBe('true');
      expect(r.status, out).toBe(2);
      expect(out).toMatch(/клон усечён/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('неоднозначное короткое имя идёт в храповик, а не в тишину', () => {
    // Прежде `resolveRef` возвращал `ambiguous`, и ветвь молча делала continue: точную ссылку
    // можно было бесшумно понизить до неоднозначной.
    mkdirSync(join(sandbox, 'web', 'other'), { recursive: true });
    writeFileSync(join(sandbox, 'web', 'other', 'twin.md'), 'A\n');
    writeFileSync(join(sandbox, 'web', 'src', 'twin.md'), 'B\n');
    const r = run(sandbox, '## P\n\nСсылка: `twin.md`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/подходит к 2 файлам/);
  });

  it('регистр определяется индексом git, а не файловой системой', () => {
    // Вход, не зависящий от ФС: путь есть в ИНДЕКСЕ, но на диске его нет — ровно то состояние, в
    // котором оказывается ссылка с неверным регистром на Linux-раннере (индекс знает одно
    // написание, попытка открыть другое проваливается). Без такого входа ветвь непроверяема на
    // macOS: там `existsSync` находит файл при любом регистре и предмет мутации не исчезает —
    // прогон остаётся зелёным не потому, что проверка декоративна, а потому, что мутация не
    // убрала предмет. Различать эти два случая обязательно.
    writeFileSync(join(sandbox, 'web', 'src', 'case-probe.ts'), 'export const probe = 1;\n');
    // Состояние публикуется, пока файл ещё существует: `run()` делает `git add -A`, поэтому
    // удалять его надо ПОСЛЕ фиксации — иначе удаление попадёт в индекс и предмет исчезнет
    // вместе с диском (ровно на этом первая редакция теста и упала).
    run(sandbox, '## P\n\nСсылка: `web/src/CASE-PROBE.ts:1`, `probe`.\n');
    rmSync(join(sandbox, 'web', 'src', 'case-probe.ts'), { force: true });
    expect(existsSync(join(sandbox, 'web', 'src', 'case-probe.ts'))).toBe(false);
    const tracked = execFileSync('git', ['-C', sandbox, 'ls-files', 'web/src/case-probe.ts'], {
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('web/src/case-probe.ts');
    const g = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), { cwd: sandbox, encoding: 'utf8' });
    const out = `${g.stdout ?? ''}${g.stderr ?? ''}`;
    expect(g.status, out).toBe(1);
    expect(out).toMatch(/регистр пути/);
  });

  it('неверный регистр КОРОТКОГО имени — код 1, а не тишина', () => {
    const r = run(sandbox, '## P\n\nСсылка: `THING.ts`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/регистр имени не совпадает/);
  });

  it('удаление ветки под ОБЪЯВЛЕННОЙ ревизией не меняет реестр и не красит гейт', () => {
    // Главная гарантия объявления: переход «ветка жива → удалена» при НЕИЗМЕННЫХ реестрах.
    // Прежде запись в реестр делалась только в состоянии «недостижима», поэтому переход
    // создавал новую запись и давал код 1 — тесты проверяли два состояния порознь, а переход
    // не проверял никто.
    const sha = makeBranchOnlyRevision(sandbox, 'onSideT');
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      `# пусто\nopenspec/specs/demo/spec.md :: ${sha} :: external-revision\n`,
    );
    const body = `## P\n\nСсылка: \`web/src/thing.ts@${sha}:3\`, \`const onSideT\`.\n`;
    // Пока ветка жива запись в реестре обязана быть — иначе её появление после удаления ветки
    // и есть тот самый разрыв храповика.
    const alive = run(sandbox, body);
    expect(alive.code, alive.out).toBe(1);
    expect(alive.out).toMatch(/НОВЫЕ НЕИЗМЕРИМЫЕ/);
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      `# пусто\nopenspec/specs/demo/spec.md :: web/src/thing.ts@${sha}:3\n`,
    );
    const registered = run(sandbox, body);
    expect(registered.code, registered.out).toBe(0);
    // Ветка удалена — реестры не тронуты, вердикт не изменился.
    execFileSync('git', ['-C', sandbox, 'push', '-q', 'origin', '--delete', 'side']);
    execFileSync('git', ['-C', sandbox, 'fetch', '-q', '--prune', 'origin']);
    const afterDelete = run(sandbox, body);
    expect(afterDelete.code, afterDelete.out).toBe(0);
    expect(afterDelete.out).toMatch(/объявлено вне main/);
  });

  it('негодная ревизия — расхождение, а не тихий пропуск', () => {
    // PATH_SPAN принимает 7–40 строчных hex: шесть символов, 41, верхний регистр и нехекс-опечатка
    // давали parsed=null и выпадали целиком. Измерено на дереве: три таких ссылки — код 0.
    for (const rev of [
      '45297b',
      '45297bg',
      '45297B4DD90F1F174553F9840F3A69DF9D38F252',
      '45297b4dd90f1f174553f9840f3a69df9d38f2521',
    ]) {
      const r = run(sandbox, `## P\n\nСсылка: \`web/src/thing.ts@${rev}:1\`, \`marker\`.\n`);
      expect(r.code, `${rev}: ${r.out}`).toBe(1);
      expect(r.out, rev).toMatch(/сокращённо|не полным 40-символьным/);
    }
  });

  it('версии и адреса почты в класс ревизий не попадают', () => {
    // Ложные попадания отсекает требование к ЛЕВОЙ части (она обязана выглядеть путём), а не
    // класс символов: иначе `node@20` стал бы «негодной ревизией».
    const r = run(
      sandbox,
      '## P\n\nНе ссылки: `node@20`, `astro@7.2.0`, `someone@example.com`. Ссылка: `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(0);
  });

  it('выход за пределы репозитория по symlink — код 1, а не «сверено»', () => {
    // statSync и readFileSync идут по символической ссылке: repo-путь сверялся по содержимому
    // внешнего файла, и счётчик «сверено» РОС. Для проверки, существующей ради доказуемости
    // ссылок, это худший исход — она подтверждает то, чего в репозитории нет.
    const outside = join(sandbox, '..', `outside-${'probe'}.txt`);
    writeFileSync(outside, 'секрет снаружи\n');
    symlinkSync(outside, join(sandbox, 'web', 'src', 'link.ts'));
    try {
      const r = run(sandbox, '## P\n\nСсылка: `web/src/link.ts:1`, `секрет снаружи`.\n');
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/за пределы репозитория по символической ссылке/);
      expect(r.out).toMatch(/содержимое сверено у 0/);
    } finally {
      rmSync(join(sandbox, 'web', 'src', 'link.ts'), { force: true });
      rmSync(outside, { force: true });
      execFileSync('git', ['-C', sandbox, 'add', '-A']);
      execFileSync('git', ['-C', sandbox, 'commit', '-q', '-m', 'cleanup', '--allow-empty']);
    }
  });

  it('объявление по артефакту проверяется ПО СВОЕМУ артефакту, а не глобально', () => {
    // Обратная сверка теряла владельца ключа: упоминание того же SHA в другом файле держало
    // устаревшее разрешение живым, то есть узкий ключ работал как wildcard.
    const sha = makeBranchOnlyRevision(sandbox, 'onSideOwner');
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      `# пусто\nopenspec/changes/demo-change/tasks.md :: ${sha} :: external-revision\n`,
    );
    // SHA упомянут в ДРУГОМ артефакте (принятой спеке), а объявление привязано к tasks.md.
    const r = run(sandbox, `## P\n\nФакт найден на \`side@${sha}\`, ссылка \`web/src/thing.ts:1\`, \`marker\`.\n`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/МЁРТВЫЕ ОБЪЯВЛЕНИЯ РЕВИЗИЙ/);
  });

  it('голые SHA считаются без тех, что входят в ссылки', () => {
    // Прежде печатались все 40-hex подряд, включая SHA внутри `путь@sha` — число было завышено
    // вдвое, а в «потерю» попадала ревизия, которая как раз проверяется.
    const sha = execFileSync('git', ['-C', sandbox, 'rev-parse', 'refs/remotes/origin/main'], {
      encoding: 'utf8',
    }).trim();
    const r = run(
      sandbox,
      `## P\n\nСсылка: \`web/src/thing.ts@${sha}:1\`, \`marker\`. Точный коммит — ${sha}.\n`,
    );
    expect(r.code, r.out).toBe(0);
    // Тот же SHA и в ссылке, и голым: голым он не считается вовсе.
    expect(r.out).not.toMatch(/голых SHA/);
  });

  it('`dist/` попадает в сборочный вывод, а не в отброшенную прозу', () => {
    // Отбрасывание прозы стояло РАНЬШЕ классификации: ссылка на сборочный вывод без расширения
    // уходила в тишину, потому что первого сегмента нет в корне.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/\n',
    );
    const r = run(sandbox, '## P\n\nВывод: `dist/`.\n');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/в сборочный вывод/);
  });

  it('отброшенная как проза ссылка без расширения идёт в храповик и печатается числом', () => {
    const body = '## P\n\nТип `text/html`, ссылка `web/src/thing.ts:1`, `marker`.\n';
    const fresh = run(sandbox, body);
    expect(fresh.code, fresh.out).toBe(1);
    expect(fresh.out).toMatch(/отброшено как проза/);
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: text/html\n',
    );
    const registered = run(sandbox, body);
    expect(registered.code, registered.out).toBe(0);
    expect(registered.out).toMatch(/1 отброшено как проза/);
  });

  it('регистр каталога и сокращённого пути — по индексу git, одинаково в любой среде', () => {
    // Вход, не зависящий от ФС: каталог есть в ИНДЕКСЕ, на диске его нет. Без него проверка
    // регистра каталога оказалась ложнозелёной — она сидела внутри ветви «каталог найден на
    // диске», поэтому на macOS ловила расхождение, а на Linux-раннере span молча уходил в
    // «прозу». Локально было зелено, поймал собственный тест в CI: там `WEB/` не находится.
    // Каталог ВЕРХНЕГО уровня: именно он воспроизводит Linux на macOS. Прежняя редакция теста
    // брала `web/CaseDir`, у которого первый сегмент (`web`) существует, поэтому span доживал до
    // проверки в любой среде — и та же ошибка «предмет исчезает раньше проверки» осталась
    // ненайденной ДВАЖДЫ: на Linux `WEB/` отбрасывается ветвью прозы, потому что первого сегмента
    // нет в корне. Здесь каталог есть в индексе git и отсутствует на диске, то есть первый
    // сегмент не находится ни при какой чувствительности ФС к регистру.
    mkdirSync(join(sandbox, 'TopCase', 'inner'), { recursive: true });
    writeFileSync(join(sandbox, 'TopCase', 'inner', 'x.ts'), 'export const x = 1;\n');
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    rmSync(join(sandbox, 'TopCase'), { recursive: true, force: true });
    expect(existsSync(join(sandbox, 'TopCase'))).toBe(false);
    const gone = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), { cwd: sandbox, encoding: 'utf8' });
    // Дерево уже не содержит каталога, но индекс содержит — расхождение регистра обязано
    // называться и здесь, иначе вердикт зависит от файловой системы исполнителя.
    writeFileSync(
      join(sandbox, 'openspec', 'specs', 'demo', 'spec.md'),
      '## P\n\nКаталог `topcase/`, ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    const idx = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), { cwd: sandbox, encoding: 'utf8' });
    const idxOut = `${idx.stdout ?? ''}${idx.stderr ?? ''}`;
    expect(idx.status, `${idxOut}\n(контроль без ссылки: ${gone.status})`).toBe(1);
    expect(idxOut).toMatch(/регистр каталога не совпадает/);
    const dir = run(sandbox, '## P\n\nКаталог `WEB/`, ссылка `web/src/thing.ts:1`, `marker`.\n');
    expect(dir.code, dir.out).toBe(1);
    expect(dir.out).toMatch(/регистр каталога не совпадает/);
    const short = run(sandbox, '## P\n\nСсылка `src/Thing.ts`, а также `web/src/thing.ts:1`, `marker`.\n');
    expect(short.code, short.out).toBe(1);
    expect(short.out).toMatch(/регистр/);
  });

  it('symlink наружу не обходится сокращённым путём', () => {
    // Проверка стояла у части входов: сокращённый путь разрешается по хвосту ПОЗЖЕ, и внешний
    // файл снова выдавался за проверенный. Теперь признак на выходе разрешения.
    const outside = join(sandbox, '..', 'outside-tail.txt');
    writeFileSync(outside, 'снаружи по хвосту\n');
    symlinkSync(outside, join(sandbox, 'web', 'src', 'tail-link.ts'));
    try {
      const r = run(sandbox, '## P\n\nСсылка: `src/tail-link.ts:1`, `снаружи по хвосту`.\n');
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/за пределы репозитория по символической ссылке/);
    } finally {
      rmSync(join(sandbox, 'web', 'src', 'tail-link.ts'), { force: true });
      rmSync(outside, { force: true });
    }
  });

  it('symlink на КАТАЛОГ наружу — тоже расхождение', () => {
    const outsideDir = join(sandbox, '..', 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'x.txt'), 'x\n');
    symlinkSync(outsideDir, join(sandbox, 'web', 'linked-dir'));
    try {
      const r = run(sandbox, '## P\n\nКаталог `web/linked-dir/`, ссылка `web/src/thing.ts:1`, `marker`.\n');
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/каталог .* уходит за пределы репозитория/);
    } finally {
      // Символическую ссылку НА КАТАЛОГ снимает `unlinkSync`: `rmSync` без `recursive` даёт
      // EISDIR, и уборка теста падала после успешной проверки — красное по своей же причине.
      unlinkSync(join(sandbox, 'web', 'linked-dir'));
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('исчезновение предмета extensionless-ссылки видно храповику', () => {
    // Прежде удалённый `specs/<capability>/` тихо переходил из класса каталогов в класс прозы, и
    // код оставался 0: печатаемое число ловит рост класса, но не подмену.
    mkdirSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'specs', 'cap'), { recursive: true });
    writeFileSync(
      join(sandbox, 'openspec', 'changes', 'demo-change', 'specs', 'cap', 'spec.md'),
      '## Requirement: X\n\nТекст.\n',
    );
    const body = '## P\n\nКаталог `specs/cap/`, ссылка `web/src/thing.ts:1`, `marker`.\n';
    writeFileSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'tasks.md'), body);
    const before = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(before.code, before.out).toBe(0);
    // Предмет исчез — гейт обязан это заметить, а не молча переклассифицировать ссылку.
    rmSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'specs'), { recursive: true, force: true });
    const after = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(after.code, after.out).toBe(1);
    expect(after.out).toMatch(/отброшено как проза/);
  });

  it('номер строки входит в идентичность внешней ссылки', () => {
    // Без него разные участки одного внешнего файла схлопывались в одну запись реестра.
    const sha = makeBranchOnlyRevision(sandbox, 'onSideLines');
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      `# пусто\nopenspec/specs/demo/spec.md :: ${sha} :: external-revision\n`,
    );
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      `# пусто\nopenspec/specs/demo/spec.md :: web/src/thing.ts@${sha}:3\n`,
    );
    const one = run(sandbox, `## P\n\nСсылка: \`web/src/thing.ts@${sha}:3\`, \`const onSideLines\`.\n`);
    expect(one.code, one.out).toBe(0);
    // Вторая ссылка на ДРУГУЮ строку того же файла — новая запись реестра, а не та же самая.
    const two = run(
      sandbox,
      `## P\n\nСсылки: \`web/src/thing.ts@${sha}:3\`, \`const onSideLines\` и \`web/src/thing.ts@${sha}:1\`, \`export const marker\`.\n`,
    );
    expect(two.code, two.out).toBe(1);
    expect(two.out).toMatch(/НОВЫЕ НЕИЗМЕРИМЫЕ/);
  });

  it('негодная ревизия: любая форма, но не законная запись workflow и не версия', () => {
    for (const span of [
      'web/src/thing.ts@abc:1',
      'web/src/thing.ts@dead-beef',
      'web/src/thing.ts@dead_beef',
      'main@d7e9b0',
    ]) {
      const r = run(sandbox, `## P\n\nСсылка: \`${span}\`.\n`);
      expect(r.code, `${span}: ${r.out}`).toBe(1);
      expect(r.out, span).toMatch(/не полным 40-символьным|сокращённо/);
    }
    const legit = run(
      sandbox,
      '## P\n\nЗаконные: `dependabot-auto-merge.yml@refs/heads/main`, `node@20`, `astro@7.2.0`, `@astrojs/react`. Ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(legit.code, legit.out).toBe(0);
  });

  it('--check-built различает файл и каталог с тем же именем', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/index.html\n',
    );
    run(sandbox, '## P\n\nСтраница: `dist/index.html`.\n');
    // Каталог с именем страницы прежде сходил за найденную страницу: проверялось только
    // существование записи, а не её род.
    mkdirSync(join(sandbox, 'web', 'dist', 'index.html'), { recursive: true });
    const gate = join(sandbox, 'bin', 'check-spec-refs');
    const asDir = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    const asDirOut = `${asDir.stdout ?? ''}${asDir.stderr ?? ''}`;
    expect(asDir.status, asDirOut).toBe(1);
    expect(asDirOut).toMatch(/это каталог, а ссылка требует файл/);
    rmSync(join(sandbox, 'web', 'dist', 'index.html'), { recursive: true, force: true });
    writeFileSync(join(sandbox, 'web', 'dist', 'index.html'), '<html></html>\n');
    const asFile = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    expect(asFile.status, `${asFile.stdout}${asFile.stderr}`).toBe(0);
  });

  it('ссылка на артефакт заархивированного change разрешается по датовому префиксу', () => {
    // Каталог архива получает датовый префикс, поэтому склейка archive/<dir>/<имя>/<артефакт>
    // удваивала имя change: три ссылки чужого change стали «ссылками в пустоту» при существующих
    // файлах. Измерено сразу после архивирования online-payment-flow.
    const arch = join(sandbox, 'openspec', 'changes', 'archive', '2026-08-21-gone-change');
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, 'proposal.md'), '# proposal\n');
    const r = run(sandbox, '## P\n\nСсылка: `gone-change/proposal.md`.\n');
    expect(r.code, r.out).toBe(0);
  });

  it('регистр пути с ревизией сверяется до классификации «ref@sha»', () => {
    // Форма `WEB/src/thing@<sha>` на Linux (пути нет) уходила в класс «только по ревизии», а на
    // macOS краснела как расхождение регистра — снова два вердикта в двух средах. Вход не зависит
    // от ФС: путь есть в индексе, на диске его нет.
    writeFileSync(join(sandbox, 'web', 'src', 'probe-case.ts'), 'export const p = 1;\n');
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    rmSync(join(sandbox, 'web', 'src', 'probe-case.ts'), { force: true });
    const sha = execFileSync('git', ['-C', sandbox, 'rev-parse', 'refs/remotes/origin/main'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(sandbox, 'openspec', 'specs', 'demo', 'spec.md'),
      `## P\n\nФакт найден в \`web/src/PROBE-CASE.ts@${sha}\`.\n`,
    );
    const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), { cwd: sandbox, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(1);
    expect(out).toMatch(/регистр пути не совпадает/);
  });

  it('адрес с портом путём не считается', () => {
    // Форма взята с реального дерева: `127.0.0.1:8787` разбирается как путь плюс «номер строки»,
    // и без оговорки давала «путь не существует» — то есть требовала объявить адрес стенда
    // ссылкой в пустоту. Первая редакция теста брала адрес БЕЗ порта, которого в артефактах нет:
    // мутация тогда не краснела, и по одному прогону это выглядело как декоративная проверка.
    const r = run(
      sandbox,
      '## P\n\nСервис слушает `127.0.0.1:8787`, ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/127\.0\.0\.1/);
  });

  it('--write-absent применим к файлу с заполнителем причины', () => {
    // Чтение отвергало ТРЕБУЕТСЯ-ПРИЧИНА кодом 2 раньше записи, поэтому режим был неприменим
    // ровно в том состоянии, для которого он нужен.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/gone.ts :: ТРЕБУЕТСЯ-ПРИЧИНА\n',
    );
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    const w = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-absent'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    const out = `${w.stdout ?? ''}${w.stderr ?? ''}`;
    expect(out).toMatch(/записано \d+ строк/);
    // Строка без предмета из файла ушла: перезапись состоялась.
    expect(readFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), 'utf8')).not.toMatch(/gone\.ts/);
  });

  it('признак ревизии: hex-подобный хвост ловится, законные ссылки — нет', () => {
    // Прежняя редакция решала по ЛЕВОЙ части и объявляла негодными законные записи (измерено три
    // расхождения: actions/checkout@v4, docker/build-push-action@main, first.last@example.com),
    // а хвосты с косой чертой исключала целиком и пропускала @dead/beef.
    for (const span of [
      'web/src/thing.ts@abc:1',
      'web/src/thing.ts@dead-beef',
      'web/src/thing.ts@dead_beef',
      'web/src/thing.ts@dead/beef',
      'main@d7e9b0',
    ]) {
      const r = run(sandbox, `## P\n\nСсылка: \`${span}\`.\n`);
      expect(r.code, `${span}: ${r.out}`).toBe(1);
      expect(r.out, span).toMatch(/не полным 40-символьным|сокращённо/);
    }
    const legit = run(
      sandbox,
      '## P\n\nЗаконные: `actions/checkout@v4`, `docker/build-push-action@main`, ' +
        '`first.last@example.com`, `dependabot-auto-merge.yml@refs/heads/main`, `node@20`, ' +
        '`astro@7.2.0`. Ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(legit.code, legit.out).toBe(0);
  });

  it('symlink наружу внутри собранного дерева — расхождение, а не «проверено»', () => {
    const outside = join(sandbox, '..', 'outside-built.html');
    writeFileSync(outside, '<html>снаружи</html>\n');
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    symlinkSync(outside, join(sandbox, 'web', 'dist', 'index.html'));
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/index.html\n',
    );
    try {
      run(sandbox, '## P\n\nСтраница: `dist/index.html`.\n');
      const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--check-built'], {
        cwd: sandbox,
        encoding: 'utf8',
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status, out).toBe(1);
      expect(out).toMatch(/уходит за пределы репозитория/);
    } finally {
      unlinkSync(join(sandbox, 'web', 'dist', 'index.html'));
      rmSync(outside, { force: true });
    }
  });

  it('ссылка `./имя` на корневой файл проверяема, в отличие от голого имени', () => {
    // Обход ограничения односегментной формы: `./Dockerfile` однозначен, проза так не пишет.
    writeFileSync(join(sandbox, 'Dockerfile'), 'FROM scratch\n');
    const present = run(sandbox, '## P\n\nСборка описана в `./Dockerfile`.\n');
    expect(present.code, present.out).toBe(0);
    // Предмет исчез — ссылка обязана перестать быть зелёной, в отличие от голого `Dockerfile`.
    rmSync(join(sandbox, 'Dockerfile'), { force: true });
    const gone = run(sandbox, '## P\n\nСборка описана в `./Dockerfile`.\n');
    expect(gone.code, gone.out).toBe(1);
    expect(gone.out).toMatch(/путь не существует|НЕСУЩЕСТВУЮЩИЕ/);
  });

  it('регистр каталога внутри change сверяется относительно корня change', () => {
    mkdirSync(join(sandbox, 'openspec', 'changes', 'demo-change', 'specs', 'cap'), { recursive: true });
    writeFileSync(
      join(sandbox, 'openspec', 'changes', 'demo-change', 'specs', 'cap', 'spec.md'),
      '## Requirement: X\n\nТекст.\n',
    );
    writeFileSync(
      join(sandbox, 'openspec', 'changes', 'demo-change', 'tasks.md'),
      '## Задача\n\nКаталог `Specs/cap/`.\n',
    );
    const r = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/регистр каталога не совпадает/);
  });

  it('--check-built не принимает каталог с длинным расширением за файл', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/manifest.webmanifest\n',
    );
    run(sandbox, '## P\n\nМанифест: `dist/manifest.webmanifest`.\n');
    mkdirSync(join(sandbox, 'web', 'dist', 'manifest.webmanifest'), { recursive: true });
    const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--check-built'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(1);
    expect(out).toMatch(/это каталог, а ссылка требует файл/);
  });

  it('--write-debt не зеленит файл причин с заполнителем', () => {
    // Прежде режим записи выходил нулём, оставляя состояние, которое обычный прогон отвергает
    // кодом 2: «команда прошла» читалось как «гейт зелёный».
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/src/gone.ts :: ТРЕБУЕТСЯ-ПРИЧИНА\n',
    );
    run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    const w = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-debt'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    expect(w.status, `${w.stdout}${w.stderr}`).toBe(2);
  });

  it('ревизия: признак по предмету слева, без порогов', () => {
    // Порог по доле hex-символов ошибался в обе стороны. Теперь: слева файл или известный ref ⇒
    // справа обязана быть ревизия; иначе span не наш. Обе стороны контракта в одном тесте.
    for (const span of [
      'web/src/thing.ts@not-a-sha',
      'web/src/thing.ts@abc:1',
      'web/src/thing.ts@45297bg',
      'web/src/thing.ts@dead/beef',
    ]) {
      const r = run(sandbox, `## P\n\nСсылка: \`${span}\`.\n`);
      expect(r.code, `${span}: ${r.out}`).toBe(1);
      expect(r.out, span).toMatch(/не полным 40-символьным|сокращённо/);
    }
    const legit = run(
      sandbox,
      '## P\n\nЗаконные: `actions/cache@beta`, `feature@feedback`, `actions/checkout@v4`, ' +
        '`docker/build-push-action@main`, `first.last@example.com`, `node@20`, `astro@7.2.0`, ' +
        '`main@…`. Ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(legit.code, legit.out).toBe(0);
  });

  it('известное имя ветки слева делает хвост ревизией', () => {
    // Форма «где найден факт»: `<ref>@<sha>`. Ветка `side` в песочнице существует, поэтому
    // испорченный хвост при ней — расхождение, а при несуществующем имени — нет.
    makeBranchOnlyRevision(sandbox, 'onSideRef');
    const known = run(sandbox, '## P\n\nФакт найден на `side@d7e9b0`.\n');
    expect(known.code, known.out).toBe(1);
    expect(known.out).toMatch(/не полным 40-символьным/);
    const unknown = run(
      sandbox,
      '## P\n\nПакет `nosuchref@d7e9b0`, ссылка `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(unknown.code, unknown.out).toBe(0);
  });

  it('--check-built ищет предмет строго внутри корня сборки', () => {
    // Чужой файл не должен закрывать исчезнувший: `dist/index.html` относится к `web/dist`, а
    // прежний список кандидатов принимал и корневой `dist/index.html`.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/index.html\n',
    );
    run(sandbox, '## P\n\nСтраница: `dist/index.html`.\n');
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    mkdirSync(join(sandbox, 'dist'), { recursive: true });
    writeFileSync(join(sandbox, 'dist', 'index.html'), '<html>чужой</html>\n');
    const gate = join(sandbox, 'bin', 'check-spec-refs');
    const r = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(1);
    expect(out).toMatch(/в собранном дереве пути нет/);
    rmSync(join(sandbox, 'dist'), { recursive: true, force: true });
  });

  it('регистр корня сборки называется расхождением', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: WEB/dist/index.html\n',
    );
    const r = run(sandbox, '## P\n\nСтраница: `WEB/dist/index.html`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/регистр каталога сборки не совпадает/);
  });

  it('род записи в сборке определяется точкой, а не длиной расширения', () => {
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: dist/name.abcdefghijklmn\n',
    );
    run(sandbox, '## P\n\nФайл: `dist/name.abcdefghijklmn`.\n');
    mkdirSync(join(sandbox, 'web', 'dist', 'name.abcdefghijklmn'), { recursive: true });
    const r = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--check-built'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, out).toBe(1);
    expect(out).toMatch(/это каталог, а ссылка требует файл/);
  });

  it('--write-absent приводит реестр в приемлемое состояние за ОДИН прогон', () => {
    // Прежде обратная сверка шла по карте, прочитанной до записи, и первый прогон после снятия
    // устаревшей записи всё равно выходил кодом 1.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/nope.ts :: will-create\n',
    );
    const before = run(sandbox, '## P\n\nСсылка: `web/src/thing.ts:1`, `marker`.\n');
    expect(before.code, before.out).toBe(1);
    const w = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-absent'], {
      cwd: sandbox,
      encoding: 'utf8',
    });
    expect(w.status, `${w.stdout}${w.stderr}`).toBe(0);
    const after = spawnSync(join(sandbox, 'bin', 'check-spec-refs'), { cwd: sandbox, encoding: 'utf8' });
    expect(after.status, `${after.stdout}${after.stderr}`).toBe(0);
  });

  it('заголовок реестра называет шесть классов', () => {
    spawnSync(join(sandbox, 'bin', 'check-spec-refs'), ['--write-debt'], { cwd: sandbox });
    const header = readFileSync(join(sandbox, 'openspec', '.spec-ref-debt'), 'utf8');
    expect(header).toMatch(/Шесть классов/);
    const listed = (header.match(/^#\s+\d\./gm) ?? []).length;
    expect(listed, header.slice(0, 600)).toBe(6);
  });
  it('файл репозитория при имени ветки справа — расхождение, а не тишина', () => {
    // Правила прямо запрещают имя ветки как идентификатор состояния: она сдвигается, а
    // неопубликованная исчезает. Прежняя редакция исключала ЛЮБОЙ хвост на `refs/`, поэтому такая
    // ссылка выпадала из проверки целиком — измерено на реальном репозитории: вывод гейта с двумя
    // такими пробами совпал с базовым побайтово, ни один счётчик не сдвинулся.
    const r = run(
      sandbox,
      '## P\n\nСсылка: `web/src/thing.ts@refs/heads/main`, и проверяемая `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/не полным 40-символьным SHA/);
  });

  it('точка в хвосте не выводит ссылку из проверки', () => {
    // `not.a.sha` отсекался классом символов хвоста, где точки не было, — и ссылка на РЕВИЗИЮ
    // молча уходила в прозу. Проза отсекается не классом символов, а требованием «слева файл
    // репозитория либо известный ref», и следующий тест это подтверждает.
    const r = run(
      sandbox,
      '## P\n\nСсылка: `web/src/thing.ts@not.a.sha`, и проверяемая `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/not\.a\.sha/);
  });

  it('запись workflow на ref остаётся законной — и проверка на этом не вакуумна', () => {
    // Единственное названное исключение для `refs/`. Тест обязан быть непустым: без файла в
    // индексе `dependabot-auto-merge.yml` не является файлом репозитория, и запись проходила бы
    // не благодаря исключению, а потому что в класс не попадает вовсе.
    mkdirSync(join(sandbox, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(sandbox, '.github', 'workflows', 'dependabot-auto-merge.yml'), 'name: x\n');
    // Проверяемая ссылка в тексте обязательна: сама по себе законная запись workflow ссылкой не
    // является, и прогон без единой проверяемой ссылки гейт объявляет вакуумным (код 2) — верно
    // по существу, но тогда тест доказывал бы не то, что назван доказывать.
    const legit = run(
      sandbox,
      '## P\n\nЗапись: `dependabot-auto-merge.yml@refs/heads/main`. Ссылка: `web/src/thing.ts:1`, `marker`.\n',
    );
    const tracked = execFileSync('git', ['-C', sandbox, 'ls-files', '.github/workflows'], {
      encoding: 'utf8',
    });
    expect(tracked).toMatch(/dependabot-auto-merge\.yml/);
    expect(legit.code, legit.out).toBe(0);
    // А тот же ref у файла НЕ из `.github/workflows` — расхождение: исключение сужено по месту
    // файла в индексе, а не по совпадению имени.
    const other = run(
      sandbox,
      '## P\n\nСсылка: `web/src/thing.ts@refs/heads/main`, и проверяемая `web/src/thing.ts:1`, `marker`.\n',
    );
    expect(other.code, other.out).toBe(1);
  });

  it('--check-built сверяет регистр каждого сегмента внутри корня, а не только корень', () => {
    // На macOS `existsSync` находит `web/dist/index.html` по обращению `web/dist/INDEX.HTML`, на
    // Linux CI — нет. Один коммит, два вердикта: ровно тот класс, из-за которого предикаты рабочего
    // дерева переведены на индекс git.
    mkdirSync(join(sandbox, 'web', 'dist'), { recursive: true });
    writeFileSync(join(sandbox, 'web', 'dist', 'index.html'), '<html></html>\n');
    const gate = join(sandbox, 'bin', 'check-spec-refs');
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/dist/INDEX.HTML\n',
    );
    run(sandbox, '## P\n\nСтраница: `web/dist/INDEX.HTML`.\n');
    const wrong = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    const wrongOut = `${wrong.stdout ?? ''}${wrong.stderr ?? ''}`;
    expect(wrong.status, wrongOut).toBe(1);
    expect(wrongOut).toMatch(/регистр в собранном дереве не совпадает/);
    // Контроль: точный регистр остаётся проверенным — иначе проверка краснела бы на всём подряд и
    // о регистре не говорила ничего.
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-debt'),
      '# пусто\nopenspec/specs/demo/spec.md :: web/dist/index.html\n',
    );
    run(sandbox, '## P\n\nСтраница: `web/dist/index.html`.\n');
    const right = spawnSync(gate, ['--check-built'], { cwd: sandbox, encoding: 'utf8' });
    const rightOut = `${right.stdout ?? ''}${right.stderr ?? ''}`;
    expect(right.status, rightOut).toBe(0);
    expect(rightOut).toMatch(/сборочный вывод проверен в собранном дереве: 1/);
  });
});
