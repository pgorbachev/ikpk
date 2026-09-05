import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

// Правила репозитория, которые ломаются молча и потому нуждаются в гейте.
const ROOT = join(import.meta.dirname, '..', '..');

/** `git check-ignore` возвращает 0, если путь игнорируется, 1 — если нет. */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
    return true;
  } catch (err) {
    const code = (err as { status?: number }).status;
    // 1 — не игнорируется. Любой другой код — сбой самой проверки, и его нельзя
    // выдавать за «не игнорируется»: это разница между «дефектов нет» и «я не
    // смогла проверить».
    if (code === 1) return false;
    throw new Error(`git check-ignore завершился с кодом ${code} на пути ${path}`, {
      cause: err,
    });
  }
}

describe('гигиена репозитория', () => {
  // После перехода на SDD в `.codex/` лежит ОБЩАЯ интеграция OpenSpec
  // (`.codex/skills/**`), а не только личные настройки. Правило на весь каталог
  // заставляло `git add` отказывать без `-f`, и новые файлы после апгрейда
  // генератора пропадали бы молча — дефект без единого сигнала.
  it('общая интеграция в .codex не игнорируется', () => {
    expect(
      ignored('.codex/skills/openspec-propose.md'),
      '.codex/skills/** игнорируется — общие файлы интеграции OpenSpec будут молча пропадать',
    ).toBe(false);
  });

  it('личные настройки в .codex игнорируются', () => {
    expect(
      ignored('.codex/config.toml'),
      '.codex/config.toml не игнорируется — личные настройки уедут в репозиторий',
    ).toBe(true);
  });

  // Скрипты развёртывания вызываются из документации как `./scripts/<имя>`, и без
  // бита это не работает: `permission denied`. В git режим хранится, поэтому
  // проверяем индекс, а не права в рабочем дереве.
  it('скрипты развёртывания исполняемые в индексе git', () => {
    const listed = execFileSync('git', ['ls-files', '-s', 'scripts/'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    const shellScripts = listed
      .split('\n')
      .filter((line) => line.endsWith('.sh'))
      .map((line) => ({ mode: line.slice(0, 6), path: line.split('\t')[1] }));

    expect(
      shellScripts.length,
      'в scripts/ не найдено ни одного .sh — проверять нечего',
    ).toBeGreaterThan(0);
    // `scripts/lib/` — не точки входа, а фрагменты, подключаемые через `source`. Бит
    // исполнения им не нужен и вводил бы в заблуждение: запустить их отдельно нельзя,
    // они опираются на переменные вызывающего. Требование про бит относится к тому, что
    // документация зовёт как `./scripts/<имя>`.
    const entryPoints = shellScripts.filter((s) => !s.path.startsWith('scripts/lib/'));
    expect(
      entryPoints.length,
      'в scripts/ не осталось ни одной точки входа — проверять нечего',
    ).toBeGreaterThan(0);
    const notExecutable = entryPoints.filter((s) => s.mode !== '100755').map((s) => s.path);
    expect(
      notExecutable,
      `скрипты без бита исполнения (документация зовёт их как ./scripts/…):\n${notExecutable.join('\n')}`,
    ).toEqual([]);
    // Обратная сторона: библиотека с битом исполнения — тоже отклонение, потому что
    // приглашает запустить её отдельно. Проверяем обе стороны, а не одну.
    const libs = shellScripts.filter((s) => s.path.startsWith('scripts/lib/'));
    const wronglyExecutable = libs.filter((s) => s.mode === '100755').map((s) => s.path);
    expect(
      wronglyExecutable,
      `подключаемые фрагменты с битом исполнения (их нельзя запустить отдельно):\n${wronglyExecutable.join('\n')}`,
    ).toEqual([]);
  });

  // Режим форм: проверяется ПОВЕДЕНИЕ скрипта, а не наличие строк в тексте.
  //
  // Первая редакция искала `DEPLOY_MODE` и `exit 2` где угодно в файле и была
  // декоративной: замена всего блока обязательности на
  // `DEPLOY_MODE="${DEPLOY_MODE:-stand}"` оставляла её зелёной, то есть умолчание
  // возвращалось незамеченным (проверено ревью). Скрипт отказывает до сборки и до
  // обращений к сети, поэтому его можно просто запустить.
  it('деплой отказывается работать без явного режима форм', () => {
    const run = (env: Record<string, string>): { status: number; out: string } => {
      try {
        const out = execFileSync('bash', [join(ROOT, 'scripts', 'deploy-web.sh'), '203.0.113.1'], {
          cwd: ROOT,
          encoding: 'utf-8',
          env: { ...process.env, ...env },
          stdio: 'pipe',
        });
        return { status: 0, out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };

    const noMode = run({ DEPLOY_MODE: '', DEMO_FORMS: '' });
    expect(noMode.status, `без DEPLOY_MODE скрипт не отказал:\n${noMode.out}`).toBe(2);
    expect(noMode.out, 'отказ не называет допустимые режимы').toMatch(/stand/);

    const both = run({ DEPLOY_MODE: 'prod', DEMO_FORMS: 'stub' });
    expect(both.status, `prod + DEMO_FORMS не отвергнут:\n${both.out}`).toBe(2);

    const wrong = run({ DEPLOY_MODE: 'staging-maybe', DEMO_FORMS: '' });
    expect(wrong.status, `неизвестный режим принят:\n${wrong.out}`).toBe(2);

    // Runbook обязан показывать режим: иначе оператор снова позовёт скрипт без него.
    const runbook = readFileSync(join(ROOT, 'docs', 'deploy-vps.md'), 'utf-8');
    expect(/DEPLOY_MODE=(stand|prod)/.test(runbook), 'runbook не показывает явный режим').toBe(true);
  });

  // Файл редиректов должен попадать на сервер: генератор его создаёт, но пока
  // bootstrap не подключал `include`, а deploy не загружал файл, 265 правил
  // существовали только в репозитории.
  it('конфигурация стенда подключает файл редиректов, а деплой его загружает', () => {
    const bootstrap = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8');
    const deploy = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8');

    expect(
      existsSync(join(ROOT, 'deploy', 'nginx-redirects.conf')),
      'нет deploy/nginx-redirects.conf — запустите npm run redirects:gen',
    ).toBe(true);
    // Смотрим на ИСПОЛНЯЕМЫЙ код, а не на любое упоминание имени файла: первая
    // редакция искала подстроку по всему тексту, и удаление блока загрузки с
    // оставленным комментарием её не роняло (проверено ревью).
    const strip = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');

    expect(
      /include\s+\S*nginx-redirects\.conf/.test(strip(bootstrap)),
      'include файла редиректов закомментирован или отсутствует в vhost — правила на сервере не действуют',
    ).toBe(true);
    // Требуем именно передачу файла на сервер, а не упоминание его имени.
    const deployCode = strip(deploy);
    expect(
      /nginx-redirects\.conf/.test(deployCode),
      'deploy-web.sh не обращается к файлу редиректов',
    ).toBe(true);
    expect(
      /shared\/nginx-redirects\.conf/.test(deployCode) && /\bcat\b/.test(deployCode),
      'deploy-web.sh не загружает файл редиректов на сервер (блок передачи отсутствует)',
    ).toBe(true);
  });

  // Деплой обязан проверять то, что реально уедет на сервер, и отказываться до
  // необратимых шагов. Проверяем присутствие обеих проверок в исполняемом коде и их
  // ПОРЯДОК: сверка артефакта и preflight должны стоять раньше переключения релиза.
  it('деплой сверяет артефакт с режимом и подключение редиректов до переключения релиза', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'deploy-web.sh'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // Артефакт сверяется по ВСЕМУ набору адресов форм и против заказанного режима.
    // ЧТО именно сверяется — предмет поведенческого теста
    // (web/tests/deploy-form-links.test.ts): здесь утверждается только, что вызов
    // есть и стоит до необратимого шага. Прежняя редакция грепала внутренности
    // гейта (`form_links=`, `EXPECT_RE`, `DEMO_FORMS" == "stub"`) прямо в этом
    // файле — то есть утверждала о ТЕКСТЕ реализации, а не о её поведении, и
    // ломалась от любого выноса кода, ничего при этом не проверив по существу.
    // Проверяются ВСЕ ТРИ аргумента, а не только каталог. Находка ревью (F6): якорь
    // по одному `"$DIST_DIR"` оставался бы зелёным при захардкоженном режиме
    // (`form_links_match_mode "$DIST_DIR" prod ""`), тогда как текст отказа обещает
    // проверку «по заказанному режиму». Сообщение утверждало больше, чем признак.
    expect(
      /form_links_match_mode "\$DIST_DIR" "\$DEPLOY_MODE" "\$DEMO_FORMS"/.test(code),
      'гейт ссылок на формы не вызывается по заказанному режиму и режиму форм',
    ).toBe(true);

    // Preflight по развёрнутой конфигурации, а не по загруженному файлу.
    expect(/nginx -T/.test(code), 'нет preflight по развёрнутой конфигурации nginx').toBe(true);

    const posArtifact = code.indexOf(String.raw`form_links_match_mode "$DIST_DIR" "$DEPLOY_MODE" "$DEMO_FORMS"`);
    const posPreflight = code.indexOf('nginx -T');
    const posSwitch = code.indexOf('Switching current symlink');
    expect(posArtifact, 'сверки артефакта нет').toBeGreaterThan(0);
    expect(posPreflight, 'preflight отсутствует').toBeGreaterThan(0);
    expect(posSwitch, 'переключение релиза не найдено').toBeGreaterThan(0);
    expect(
      posArtifact < posSwitch && posPreflight < posSwitch,
      'проверки стоят ПОСЛЕ переключения релиза — отказ уже ничего не спасает',
    ).toBe(true);

    // Провал health-check — провал деплоя.
    expect(
      /Health check ПРОВАЛЕН/.test(code) && /exit 1/.test(code),
      'провал health-check не роняет деплой',
    ).toBe(true);
  });

  // Bootstrap не должен перезаписывать существующий vhost: там правки certbot.
  it('bootstrap отказывается перезаписывать существующий vhost', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(
      /-f "\$VHOST"/.test(code) && /exit 3/.test(code),
      'существующий vhost перезаписывается молча — конфигурация certbot будет снесена',
    ).toBe(true);
    expect(/FORCE_VHOST/.test(code), 'нет осознанного обхода для перезаписи').toBe(true);
  });

  // Генераторы не должны сообщать об ошибках и завершаться нулём. Проверяем
  // ПОВЕДЕНИЕ, запуская генератор на негодных данных, а не наличие строки
  // `process.exit(1)` в тексте.
  //
  // Первая редакция искала именно строку — и была декоративной дважды: её
  // удовлетворял комментарий вида «раньше здесь был process.exit(1)», а по
  // `make-derivatives.ts` она была зелёной ДО исправления, потому что `exit(1)` там
  // уже стоял в другой ветке (отсутствие каталога оригиналов). То есть негативную
  // проверку эта строка пройти не могла, хотя я утверждала обратное.
  // Явный запас времени, потому что дефолтные 5000 мс здесь — ловушка, а не запас.
  //
  // Измерено на этой ветке: изолированный прогон файла — 1294…1394 мс; тот же тест в
  // составе полного `npm test` — 8071 мс и ПАДЕНИЕ по таймауту, а следующий прогон той
  // же командой — 1433 мс. То есть красное приходило от состояния кэша и конкуренции за
  // ресурсы, а не от кода. Файл лежит в обязательном прогоне, поэтому такое ложное
  // красное останавливает выкладку боевого сайта.
  //
  // Охлаждается НЕ кэш tsx: его удаление (`rm -rf $TMPDIR/tsx-502`) не изменило ничего
  // — 1294…1335 мс, как на прогретом. Разница берётся из холодного кэша модулей и
  // параллельного прогона 16 файлов (в упавшем прогоне transform 1.32 с, import 2.88 с
  // против 39 мс и 65 мс в изолированном).
  //
  // 30 с — примерно 3,7 запаса к худшему наблюдённому. Большой таймаут здесь ничего не
  // стоит: время теста — это время подпроцесса, и на успехе тест возвращается сразу, а
  // дефект, который он стережёт (генератор вышел с нулём на конфликте), определяется
  // кодом возврата, а не длительностью. Подробности — docs/tech-debt.md, TD-18.
  it('генератор редиректов падает на конфликте в карте адресов', { timeout: 30_000 }, () => {
    const map = join(ROOT, 'discovery', 'url_map.csv');
    const rows = readFileSync(map, 'utf-8').split('\n');
    const idx = rows.findIndex((r) => r.startsWith('https://ikpk.su/contacts,'));
    expect(idx, 'в карте нет опорной строки для проверки — предмет изменился').toBeGreaterThan(0);

    const cols = rows[idx].split(',');
    cols[2] = '/konflikt-proverka';
    const withConflict = [...rows.slice(0, idx + 1), cols.join(','), ...rows.slice(idx + 1)].join(
      '\n',
    );

    // Карта передаётся генератору отдельным файлом, рабочая копия не трогается.
    const probe = join(ROOT, 'discovery', 'url_map.conflict-probe.csv');
    try {
      writeFileSync(probe, withConflict, 'utf-8');
      let status = 0;
      let output = '';
      try {
        output = execFileSync(
          'npx',
          ['tsx', 'scripts/gen-redirects.ts', '--map=discovery/url_map.conflict-probe.csv'],
          { cwd: join(ROOT, 'web'), encoding: 'utf-8', stdio: 'pipe' },
        );
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        status = e.status ?? -1;
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(status, `генератор завершился нулём на конфликте:\n${output}`).not.toBe(0);
      expect(output, 'генератор не назвал конфликт в выводе').toMatch(/КОНФЛИКТ/);
    } finally {
      // Убираем и подменённую карту, и конфиг, который генератор мог успеть
      // записать: иначе прогон со снятым отказом оставляет файл в рабочем дереве —
      // ровно тот мусор, от которого правило про постусловие мутации и написано.
      rmSync(probe, { force: true });
      rmSync(join(ROOT, 'deploy', 'nginx-redirects.probe.conf'), { force: true });
    }
  });

  // Скрипт восстановления секций должен работать из чистого checkout: прежде он
  // читал `scratch-empty.json`, которого в репозитории нет.
  it('список адресов для восстановления секций есть в репозитории', () => {
    const targets = join(ROOT, 'discovery', 'collapsible_targets.json');
    expect(existsSync(targets), `нет ${targets} — скрипт невоспроизводим из чистого checkout`).toBe(
      true,
    );
    const list = JSON.parse(readFileSync(targets, 'utf-8')) as unknown;
    expect(Array.isArray(list) && list.length > 0, 'список адресов пуст — обходить нечего').toBe(
      true,
    );

    // Ищем в КОДЕ, а не во всём файле: в пояснении к правке черновое имя названо
    // намеренно, и проверка по всему тексту краснела бы на объяснении дефекта.
    const script = readFileSync(join(ROOT, 'web', 'scripts', 'recover-collapsibles.mjs'), 'utf-8');
    const code = script
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(
      /scratch-empty\.json/.test(code),
      'скрипт снова читает черновой scratch-empty.json, которого нет в репозитории',
    ).toBe(false);
    expect(
      /collapsible_targets\.json/.test(code),
      'скрипт не берёт список адресов из репозитория',
    ).toBe(true);
  });

  // Тест с особым предметом (собранный вывод) живёт в ДВУХ списках: он исключён из
  // основного прогона и включён в специализированный. Забыть один из двух легко, и оба
  // исхода тихие: файл, исключённый и никуда не добавленный, не выполняется НИГДЕ, а файл,
  // добавленный без исключения, ещё и запускается основным прогоном без своего предмета.
  //
  // Проверяется точным равенством множеств, а не сопоставлением шаблонов: во всех трёх
  // конфигурациях перечислены конкретные файлы, поэтому равенство и есть инвариант.
  // Существование файлов проверяется отдельно — опечатка в имени согласована в обоих
  // списках и равенство прошла бы, выбирая при этом ноль файлов.
  it('тесты с особым предметом вписаны и в исключения основного прогона, и в свой конфиг', async () => {
    const load = async (file: string): Promise<{ include: string[]; exclude: string[] }> => {
      const abs = join(ROOT, 'web', file);
      expect(existsSync(abs), `нет конфигурации ${file}`).toBe(true);
      const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
      const test = (mod.default as { test?: { include?: unknown; exclude?: unknown } })?.test;
      const list = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      return { include: list(test?.include), exclude: list(test?.exclude) };
    };

    const base = await load('vitest.config.ts');
    const specialised = [
      ...(await load('vitest.build.config.ts')).include,
      ...(await load('vitest.demo.config.ts')).include,
      // Вывод сборки роли `stand`: третий артефакт обязательного прогона. Своя
      // конфигурация нужна по той же причине, что демо-выводу, — предмет проверки
      // определяется корнем, объявленным в её собственном модуле.
      ...(await load('vitest.stand.config.ts')).include,
      // Рендер компонента через Astro Container API: своя конфигурация нужна из-за
      // vite-плагина Astro, поэтому файл живёт в тех же двух списках, что и остальные
      // тесты с особым предметом.
      ...(await load('vitest.render.config.ts')).include,
    ];

    expect(specialised, 'ни один специализированный конфиг ничего не выбирает').not.toEqual([]);
    expect(
      [...base.exclude].sort(),
      'списки разошлись: файл исключён из основного прогона и не добавлен в специализированный ' +
        '(или наоборот) — он не выполняется нигде либо выполняется без своего предмета',
    ).toEqual([...specialised].sort());

    const missing = specialised.filter((f) => !existsSync(join(ROOT, 'web', f)));
    expect(missing, `в конфигурации перечислены несуществующие файлы:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  // Стенд отдаётся с публичного адреса и содержит те же тексты, что боевой сайт. Пока
  // `robots.txt` был статическим файлом в `public/`, он разрешал обход в ЛЮБОЙ сборке,
  // то есть демо конкурировал с ikpk.su как дубль, а `canonical` спасал лишь частично.
  //
  // Проверка на уровне исходников — дополнение к проверке вывода
  // (`tests/demo-output.test.ts`), а не её дубль: она ловит возврат статического файла,
  // который перекрыл бы маршрут молча, ещё до того как соберётся демо-вывод.
  it('robots.txt зависит от режима сборки', () => {
    const route = join(ROOT, 'web', 'src', 'pages', 'robots.txt.ts');
    expect(existsSync(route), 'нет генерируемого robots.txt — стенд открыт для обхода').toBe(
      true,
    );
    const code = readFileSync(route, 'utf-8');
    expect(/isDemoForms/.test(code), 'robots.txt не смотрит на режим сборки').toBe(true);
    expect(/Disallow: \//.test(code), 'в маршруте нет запрета обхода для стенда').toBe(true);
    expect(
      existsSync(join(ROOT, 'web', 'public', 'robots.txt')),
      'статический public/robots.txt перекроет генерируемый — стенд снова откроется',
    ).toBe(false);
  });

  // Корень репозитория — не свалка для сырых артефактов прогонов и скрейпа.
  //
  // Оба класса накапливались молча: восемь отчётов Lighthouse (7,8 МБ) и четыре
  // HTML-снимка старого сайта (1,4 МБ) лежали в корне, и на них не ссылался ни код,
  // ни workflow, ни документ. Заметить это нельзя ничем: сборка их не трогает, гейт
  // ссылок смотрит только `openspec/**`, а `git status` молчит про уже отслеженное.
  //
  // Признак — по СОДЕРЖИМОМУ и месту, а не по списку имён: список отстаёт от предмета
  // молча, и следующий дамп под другим именем прошёл бы мимо. Отчёт LHCI опознаётся по
  // ключу `lighthouseVersion`, который есть в любом его формате; снимок страницы — по
  // расширению в КОРНЕ (в подкаталогах HTML законен: фикстуры, свидетельства).
  const rootTracked = (): string[] =>
    execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8' })
      .split('\0')
      .filter((p) => p.length > 0 && !p.includes('/'));

  it('в корне нет сырых отчётов Lighthouse', () => {
    const files = rootTracked();
    // Пустой перечень — это «не смогла проверить», а не «дефектов нет».
    expect(files.length, 'git ls-files не вернул ни одного файла в корне — проверять нечего').toBeGreaterThan(0);

    const dumps = files
      .filter((f) => f.endsWith('.json'))
      .filter((f) => {
        const raw = readFileSync(join(ROOT, f), 'utf-8');
        // Ключ ищется в первых килобайтах: отчёт весит мегабайты, а ключ лежит в шапке.
        return /"lighthouseVersion"\s*:/.test(raw.slice(0, 4096));
      });

    expect(
      dumps,
      'сырой отчёт Lighthouse снова лежит в корне: он весит мегабайты, на него никто не ссылается, ' +
        'и LHCI пересоздаёт его каждым прогоном — храните артефакт прогона, а не копию в репозитории',
    ).toEqual([]);
  });

  it('в корне нет HTML-снимков старого сайта', () => {
    const files = rootTracked();
    expect(files.length, 'git ls-files не вернул ни одного файла в корне — проверять нечего').toBeGreaterThan(0);

    expect(
      files.filter((f) => f.endsWith('.html')),
      'HTML-снимок старого сайта снова лежит в корне: контент уже разобран в поэлементных выгрузках ' +
        'discovery, а копия страницы устаревает молча и вводит в заблуждение',
    ).toEqual([]);
  });
});

// ─── Стили Astro не достают до узлов, созданных скриптом ─────────────────────

describe('scoped-стили не целятся в теги, которые создаёт скрипт', () => {
  /**
   * Astro метит разметку компонента атрибутом `data-astro-cid-…` и переписывает
   * селекторы под него. Узел, созданный в рантайме через `document.createElement`,
   * этой метки не получает, поэтому селектор вида `.box iframe` до него НЕ доходит,
   * и элемент остаётся с браузерным умолчанием — для `iframe` это `300×150`, `inline`.
   *
   * Измерено дважды. Первый раз — карта на `/kontakty` (#202, `41091a5`), где правкой
   * стало `.contact-shell-map :global(iframe)`. Второй раз — виджет отзывов на главной,
   * где ровно тот же дефект не был исправлен вместе с первым: на стенде iframe получил
   * `304×154` при контейнере `1168×384`. Починка одного вызывающего вместо общего места
   * и есть причина, по которой понадобился этот гейт.
   *
   * Корпус берётся ИЗ ДАННЫХ: теги извлекаются из самих вызовов `createElement`, а не из
   * списка известных. Список отставал бы от предмета молча — ровно то, чем этот дефект и
   * жил пять дней.
   */
  const SRC = join(ROOT, 'web', 'src');

  function astroFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name: string) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return astroFiles(full);
      return full.endsWith('.astro') ? [full] : [];
    });
  }

  it('каждый созданный скриптом тег стилизуется через :global()', () => {
    const files = astroFiles(SRC);
    expect(files.length, 'компонентов .astro не найдено — предмета нет').toBeGreaterThan(0);

    const offenders: string[] = [];
    let inspected = 0;

    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      const tags = [...src.matchAll(/createElement\(\s*['"]([a-z][a-z0-9-]*)['"]/gi)].map((m) =>
        m[1].toLowerCase(),
      );
      if (tags.length === 0) continue;
      const style = /<style>([\s\S]*?)<\/style>/.exec(src)?.[1];
      if (!style) continue;
      inspected += 1;

      for (const tag of new Set(tags)) {
        // Селектор, оканчивающийся голым тегом: `.box iframe {`, `.a > button {`.
        const bare = new RegExp(`(^|[\\s>~+,])${tag}\\s*(,|\\{)`, 'gm');
        for (const m of style.matchAll(bare)) {
          const line = style.slice(0, m.index).split('\n').length;
          const before = style.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
          if (before.includes(':global(')) continue;
          offenders.push(`${file.slice(ROOT.length + 1)}: селектор с голым '${tag}' (строка ${line} блока стилей)`);
        }
      }
    }

    expect(inspected, 'ни один компонент не создаёт узлы скриптом — проверять нечего').toBeGreaterThan(0);
    expect(offenders, 'scoped-селектор не достанет до узла, созданного скриптом').toEqual([]);
  });
});
