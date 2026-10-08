/**
 * Клиентский entrypoint пробной машины `deploy/trial/deploy.sh`.
 *
 * Сервера здесь нет: `ssh`, `curl`, `npm`, bootstrap и сборщик артефакта — моки в PATH,
 * которые пишут свои argv в журнал. Проверяется то, что принадлежит самому CLI: режим по
 * умолчанию ничего не меняет, отказ предпроверки происходит ДО изменений, остановка на
 * ручной регистрации называет команду продолжения, повторный запуск идёт от наблюдаемого
 * состояния сервера, секреты не попадают ни в argv, ни в вывод.
 * Не проверяется: настоящие ssh/bootstrap/Strapi (это — на самой машине).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers/provision-target';

const DEPLOY = join(REPO_ROOT, 'deploy/trial/deploy.sh');
const IP = '89.111.143.219';
const PASS = 'PASS-SENTINEL-4d2b';
const TOKEN = 'TOKEN-SENTINEL-8e7a';
const NAMES = ['APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'TRANSFER_TOKEN_SALT', 'JWT_SECRET', 'ENCRYPTION_KEY', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD'];

let dir: string;
let repo: string;
let sha: string;

const sh = (cmd: string, cwd = dir) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const w = (path: string, body: string, mode = 0o644) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
};
const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');

function facts(over: Record<string, string> = {}): void {
  const f = {
    os: 'ubuntu-26.04', arch: 'x86_64', free_mb: '9000', swap: 'off', scripts: 'no', secrets: 'no',
    source_commit: '', cms: 'inactive', admin: '', release_commit: '', cert: 'no', backup: 'no', ...over,
  };
  w(join(dir, 'mock/probe.out'), Object.entries(f).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-cli-'));
  repo = join(dir, 'repo');
  // Минимальный git-репозиторий: настоящие серверные скрипты не нужны, достаточно файлов для tar.
  mkdirSync(join(repo, 'deploy/environments'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'deploy/environments/trial.env'), join(repo, 'deploy/environments/trial.env'));
  for (const n of ['prepare-host.sh', 'setup-https-ip.sh', 'refresh-site.sh', 'backup-exercise.sh', 'gen-secrets.sh']) w(join(repo, 'deploy/trial', n), '#!/bin/sh\n', 0o755);
  for (const p of ['web/a', 'media-originals/a', 'cms/src/a', 'scripts/package.json']) w(join(repo, p), 'x');
  w(join(repo, 'cms/package-lock.json'), '{}');
  mkdirSync(join(repo, 'scripts/node_modules'), { recursive: true });
  w(join(repo, '.gitignore'), 'node_modules\n');
  sh('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init', repo);
  sha = sh('git rev-parse HEAD', repo).stdout.trim();

  // Клиент: ключ, known_hosts с настоящим ключом хоста, файл секретов 0600.
  w(join(dir, 'home/.ssh/id'), 'k', 0o600);
  sh(`ssh-keygen -q -t ed25519 -N '' -f ${dir}/hostkey && printf '%s %s\\n' ${IP} "$(cut -d' ' -f1,2 ${dir}/hostkey.pub)" > ${dir}/home/.ssh/known_hosts`);
  const secrets = NAMES.map((n) => `${n}='${n === 'CONTENT_ADMIN_PASSWORD' ? PASS : n.toLowerCase() + '-v'}'`).join('\n') + '\n';
  w(join(dir, 'state/secrets.env'), secrets, 0o600);

  // Моки.
  const bin = join(dir, 'bin');
  w(join(bin, 'ssh'), `#!/bin/bash
echo "ssh $*" >> "${dir}/mock/ssh.log"
args="$*"
if [[ "$args" == *"bash -s"* ]]; then cat >/dev/null; cat "${dir}/mock/probe.out"; exit 0; fi
if [[ "$args" == *" -N "* ]]; then exec sleep 60; fi
if [[ "$args" == *"tar -C"* ]]; then cat >/dev/null; fi
exit 0
`, 0o755);
  w(join(bin, 'curl'), `#!/bin/bash
echo "curl $*" >> "${dir}/mock/curl.log"
for a in "$@"; do [[ "$a" == "-K" ]] && cat >> "${dir}/mock/curl-stdin.log"; done
url=""; for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
case "$url" in
  *_health) exit 0 ;;
  */api/institutes) printf '%s' "\${MOCK_TOKEN_CODE:-200}" ;;
  */release.json) printf '{"commit":"%s"}' "\${MOCK_RELEASE_SHA:-}" ;;
  *) [[ "$*" == *"-w"* ]] && printf '200' ;;
esac
exit 0
`, 0o755);
  w(join(bin, 'npm'), `#!/bin/bash\necho "$(basename "$PWD"): npm $*" >> "${dir}/mock/npm.log"\n[[ "$1" == ci && "$(basename "$PWD")" == cms ]] && mkdir -p node_modules\nexit 0\n`, 0o755);
  w(join(dir, 'mock/bootstrap.sh'), `#!/bin/bash
echo "bootstrap args=$* env=$ENVIRONMENT domain=$DOMAIN app_keys_set=\${APP_KEYS:+yes} art=$CMS_ARTIFACT_SOURCE" >> "${dir}/mock/bootstrap.log"
`, 0o755);
  w(join(dir, 'mock/artifact.sh'), `#!/bin/bash\necho "artifact $*" >> "${dir}/mock/artifact.log"\nmkdir -p "$1"\n`, 0o755);
  facts();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [DEPLOY, ...args], {
    encoding: 'utf8',
    detached: true, // без управляющего терминала: запрос токена с /dev/tty не должен зависнуть
    timeout: 60_000,
    env: {
      PATH: `${dir}/bin:${process.env.PATH}`,
      HOME: join(dir, 'home'),
      TMPDIR: join(dir, 'tmp'),
      REPO_ROOT: repo,
      STATE_DIR: join(dir, 'state'),
      SSH_KEY: join(dir, 'home/.ssh/id'),
      BOOTSTRAP_SCRIPT: join(dir, 'mock/bootstrap.sh'),
      ARTIFACT_SCRIPT: join(dir, 'mock/artifact.sh'),
      LOCAL_PORT: '13999',
      MOCK_RELEASE_SHA: sha,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const noSecrets = (text: string) => {
  expect(text).not.toContain(PASS);
  expect(text).not.toContain(TOKEN);
};
const allArgvLogs = () => ['ssh.log', 'curl.log', 'npm.log', 'bootstrap.log', 'artifact.log'].map((n) => read(`mock/${n}`)).join('\n');
const writeToken = () => w(join(dir, 'state/api-token'), TOKEN, 0o600);
const sshCalls = () => read('mock/ssh.log').split('\n').filter(Boolean);
const mutating = () => sshCalls().filter((l) => /install -d|prepare-host|refresh-site|setup-https|backup-exercise/.test(l));

describe('deploy.sh: режим по умолчанию и отказы предпроверки', () => {
  beforeEach(() => mkdirSync(join(dir, 'tmp'), { recursive: true }));

  it('без аргументов печатает справку и не ходит на сервер', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('deploy/trial/deploy.sh run');
    expect(read('mock/ssh.log')).toBe('');
  });

  it('plan читает состояние и ничего не меняет', () => {
    const r = run(['plan']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ОСТАНОВКА');
    expect(sshCalls()).toHaveLength(1); // единственный вызов — чтение состояния
    expect(sshCalls()[0]).toContain('bash -s');
    expect(mutating()).toEqual([]);
    expect(read('mock/bootstrap.log')).toBe('');
  });

  it.each([
    ['изменён отслеживаемый файл вне web', () => writeFileSync(join(repo, 'deploy/trial/prepare-host.sh'), '#!/bin/sh\n# changed\n')],
    ['изменён отслеживаемый файл в web', () => writeFileSync(join(repo, 'web/a'), 'changed')],
    ['лишний неотслеживаемый файл в web', () => writeFileSync(join(repo, 'web/untracked'), 'x')],
  ])('грязное дерево (%s) — отказ 2 до единого вызова ssh', (_name, dirty) => {
    dirty();
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('дерево не чистое');
    expect(read('mock/ssh.log')).toBe('');
  });

  it('чужая ОС — отказ 2 без изменений', () => {
    facts({ os: 'debian-13' });
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('ожидается ubuntu-26.04 x86_64');
    expect(mutating()).toEqual([]);
  });

  it('мало места на свежей машине — отказ 2', () => {
    facts({ free_mb: '3000' });
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('мало места');
  });

  it('неизвестный ключ хоста — отказ 2, сервер не опрашивается', () => {
    writeFileSync(join(dir, 'home/.ssh/known_hosts'), '');
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('hostkey --trust');
    expect(read('mock/ssh.log')).toBe('');
  });

  it('отпечаток, не совпавший с ожидаемым, — отказ 2', () => {
    const r = run(['run'], { EXPECTED_HOST_FINGERPRINT: 'SHA256:not-the-one' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('не совпадает с EXPECTED_HOST_FINGERPRINT');
    expect(read('mock/ssh.log')).toBe('');
  });

  it('файл секретов с лишними правами — отказ 2', () => {
    chmodSync(join(dir, 'state/secrets.env'), 0o644);
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('права');
    noSecrets(r.out);
  });

  it('SSH_KEY обязателен: без него отказ 2, ни одного вызова ssh и умолчания нет', () => {
    const r = run(['run'], { SSH_KEY: '' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('SSH_KEY не задан');
    expect(read('mock/ssh.log')).toBe('');
    expect(readFileSync(DEPLOY, 'utf8')).not.toMatch(/id_ed25519_vdsina_root/);
  });

  it('команда продолжения печатает явный SSH_KEY', () => {
    const r = run(['run']);
    expect(r.out).toContain(`SSH_KEY=${join(dir, 'home/.ssh/id')} deploy/trial/deploy.sh run`);
  });

  it('неизвестная команда — отказ 2', () => {
    expect(run(['wipe']).code).toBe(2);
  });
});

describe('deploy.sh run: этапы и остановка', () => {
  beforeEach(() => mkdirSync(join(dir, 'tmp'), { recursive: true }));

  it('на свежей машине: prepare, bootstrap, затем СТОП 10 с командой продолжения', () => {
    const r = run(['run']);
    expect(r.code).toBe(10);
    expect(sshCalls().some((l) => l.includes('install -d'))).toBe(true);
    expect(sshCalls().some((l) => l.includes('/opt/ikpk-trial/bin/prepare-host.sh'))).toBe(true);
    const boot = read('mock/bootstrap.log');
    expect(boot).toContain(`env=trial domain=${IP} app_keys_set=yes`);
    expect(read('mock/artifact.log')).toContain('artifact');
    expect(r.out).toContain('deploy/trial/deploy.sh tunnel');
    expect(r.out).toContain('deploy/trial/deploy.sh run');
    expect(r.out).toContain('Full access');
    expect(read('mock/npm.log')).toContain('cms: npm ci'); // зависимости CMS ставятся по lockfile самим этапом
    expect(read('mock/npm.log')).not.toContain('import'); // импорт до регистрации не стартует
    expect(sshCalls().some((l) => l.includes('refresh-site'))).toBe(false);
    expect(readFileSync(join(dir, 'state/deploy.state'), 'utf8')).toContain(`secrets_sha256@${IP}=`);
    noSecrets(r.out + allArgvLogs());
  });

  it('продолжение после регистрации: импорт, выпуск, HTTPS, проверка, копия — и ни одного секрета в argv и выводе', () => {
    writeToken();
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true' });
    const r = run(['run']);
    expect(r.code, r.out).toBe(0);
    expect(read('mock/bootstrap.log')).toBe(''); // уже стоит на этом SHA — не переустанавливается
    const npm = read('mock/npm.log');
    expect(npm).toContain('run import:dry');
    expect(npm).toContain('run import');
    expect(sshCalls().some((l) => l.includes('/opt/ikpk-trial/bin/refresh-site.sh'))).toBe(true);
    expect(sshCalls().some((l) => l.includes('setup-https-ip.sh 89.111.143.219'))).toBe(true);
    expect(sshCalls().some((l) => l.includes('backup-exercise.sh backup'))).toBe(true);
    expect(sshCalls().some((l) => l.includes('backup-exercise.sh verify'))).toBe(true);
    // Токен дошёл до curl через stdin (доказательство, что проверка не слепа), но не через argv.
    expect(read('mock/curl-stdin.log')).toContain(TOKEN);
    noSecrets(r.out + allArgvLogs());
    // Отметки «импорт выполнен» в клиентской памяти нет: решение берётся только с сервера.
    expect(existsSync(join(dir, 'state/deploy.state')) ? read('state/deploy.state') : '').not.toContain('import');
  });

  it('повторный запуск на готовой машине ничего не меняет', () => {
    writeToken();
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true', release_commit: sha, cert: 'yes', backup: 'yes' });
    // prepare идемпотентен и выполняется всегда; остальное — пропуск
    const r = run(['run']);
    expect(r.code, r.out).toBe(0);
    expect(read('mock/bootstrap.log')).toBe('');
    expect(read('mock/npm.log')).toBe('');
    const m = mutating().filter((l) => !/install -d|prepare-host/.test(l));
    expect(m).toEqual([]);
    expect(r.out).toContain('ГОТОВО');
  });

  it('новый SHA на готовой машине: переустановка кода и новый выпуск, без повторного импорта', () => {
    writeToken();
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: 'a'.repeat(40), cms: 'active', admin: 'true', release_commit: 'a'.repeat(40), cert: 'yes', backup: 'yes' });
    const r = run(['run']);
    expect(r.code, r.out).toBe(0);
    expect(read('mock/bootstrap.log')).toContain('bootstrap');
    expect(read('mock/npm.log')).not.toContain('import');
    expect(sshCalls().some((l) => l.includes('refresh-site.sh'))).toBe(true);
  });

  it('смена файла секретов после первого развёртывания — отказ без bootstrap', () => {
    expect(run(['run']).code).toBe(10); // первое развёртывание запоминает отпечаток
    writeFileSync(join(dir, 'state/secrets.env'), readFileSync(join(dir, 'state/secrets.env'), 'utf8').replace('encryption_key-v', 'rotated'));
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: 'b'.repeat(40), cms: 'active' });
    rmSync(join(dir, 'mock/bootstrap.log'));
    const r = run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('файл секретов изменился');
    expect(existsSync(join(dir, 'mock/bootstrap.log'))).toBe(false);
  });

  it('пересоздание VPS с тем же IP: импорт повторяется, первый выпуск не идёт на пустую CMS', () => {
    writeToken();
    const done = { swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true' };
    // 1) первая машина: bootstrap (клиент запоминает отпечаток секретов), регистрация, импорт, выпуск
    expect(run(['run']).code).toBe(10);
    facts({ ...done, release_commit: '' });
    expect(run(['run']).code).toBe(0);
    expect(read('mock/npm.log')).toContain('scripts: npm run import');
    expect(read('state/deploy.state')).toContain('secrets_sha256');
    // 2) машину пересоздали: тот же IP, всё пусто; клиентская память от прошлой машины осталась
    for (const n of ['npm.log', 'bootstrap.log', 'ssh.log']) rmSync(join(dir, 'mock', n), { force: true });
    facts();
    const r2 = run(['run']);
    expect(r2.code, r2.out).toBe(10); // bootstrap выполнен заново, затем ручная регистрация
    expect(read('mock/bootstrap.log')).toContain('bootstrap');
    expect(r2.out).not.toContain('файл секретов изменился');
    // 3) регистрация сделана, релиза на новой машине нет → импорт ОБЯЗАН повториться до выпуска
    facts({ ...done, release_commit: '' });
    const r3 = run(['run']);
    expect(r3.code, r3.out).toBe(0);
    const npm = read('mock/npm.log');
    expect(npm).toContain('scripts: npm run import:dry');
    expect(npm).toContain('scripts: npm run import\n');
    const order = sshCalls().findIndex((l) => l.includes('refresh-site'));
    expect(order).toBeGreaterThan(-1);
  });

  it('токен не принят — отказ 1, импорт не стартует', () => {
    writeToken();
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true' });
    const r = run(['run'], { MOCK_TOKEN_CODE: '401' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('токен не принят');
    expect(read('mock/npm.log')).toBe('');
    noSecrets(r.out + allArgvLogs());
  });

  it('нет токена и нет терминала — СТОП 10, а не зависание', () => {
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true' });
    const r = run(['run']);
    expect(r.code).toBe(10);
    expect(r.out).toContain('нет токена API');
    expect(read('mock/npm.log')).toBe('');
  });

  it('права файла токена шире 600 — отказ', () => {
    w(join(dir, 'state/api-token'), TOKEN, 0o644);
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true' });
    const r = run(['run']);
    expect(r.code).toBe(2);
    noSecrets(r.out);
  });

  it('verify падает, если release.json на другом SHA', () => {
    writeToken();
    facts({ swap: 'on', scripts: 'yes', secrets: 'yes', source_commit: sha, cms: 'active', admin: 'true', release_commit: sha, cert: 'yes', backup: 'yes' });
    const r = run(['verify'], { MOCK_RELEASE_SHA: 'c'.repeat(40) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('commit в release.json не равен');
  });

  it('forget стирает только клиентскую память', () => {
    sh(`printf 'import_done@${IP}=yes\\nsecrets_sha256@${IP}=abc\\n' > ${dir}/state/deploy.state`);
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    const r = run(['forget']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'state/deploy.state'), 'utf8')).toBe('');
    expect(existsSync(join(dir, 'state/secrets.env'))).toBe(true);
  });
});

// Негативный контроль: проверка «секрета нет в argv» осмысленна, только если журнал вообще ловит значения.
describe('deploy.sh: контроль самой проверки', () => {
  it('журнал argv ловит значение, если оно туда попало', () => {
    appendFileSync(join(dir, 'mock/ssh.log'), `ssh x ${TOKEN}\n`);
    expect(allArgvLogs()).toContain(TOKEN);
  });
});
