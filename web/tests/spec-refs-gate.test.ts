import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
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
  return dir;
}

/** Кладёт текст в артефакт принятой спеки и возвращает вердикт гейта. */
function run(dir: string, specBody: string): { code: number; out: string } {
  writeFileSync(join(dir, 'openspec', 'specs', 'demo', 'spec.md'), specBody);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'state', '--allow-empty']);
  const r = spawnSync(join(dir, 'bin', 'check-spec-refs'), { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

beforeAll(() => {
  sandbox = makeRepo();
});

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
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
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
    expect(r.out).toMatch(/ревизии .* в репозитории нет/);
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
    expect(r.out).toMatch(/ревизии .* нет/);
  });

  it('недостижимая ревизия, объявленная как external-revision, merge не блокирует', () => {
    // Главная находка второго круга: прежний механизм кладл такую ссылку в храповик долга, и
    // «не блокирует» превращалось в «блокирует по росту долга».
    writeFileSync(
      join(sandbox, 'openspec', '.spec-ref-absent'),
      '# пусто\n* :: 0123456789abcdef0123456789abcdef01234567 :: external-revision\n',
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
        'openspec/specs/demo/spec.md :: web/src/gone.ts :: external-revision\n',
    );
    const r = run(sandbox, '## P\n\n`web/src/gone.ts`.\n');
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/повторяющиеся ключи/);
    writeFileSync(join(sandbox, 'openspec', '.spec-ref-absent'), '# пусто\n');
  });

  it('неверный регистр пути — код 1 (важно для Linux-раннера)', () => {
    const r = run(sandbox, '## P\n\n`web/src/THING.ts:1`, `marker`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/регистр пути|путь не существует/);
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

  it('ссылка без номера строки и без фрагмента идёт в храповик, а не в «проверено»', () => {
    const r = run(sandbox, '## Purpose\n\nСсылка: `web/src/thing.ts:1`.\n');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/номер строки без фрагмента/);
  });
});
