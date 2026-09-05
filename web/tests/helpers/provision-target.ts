/**
 * Цель проверки для change `server-provisioning`: одноразовый контейнер Debian 12.
 *
 * Решение 2 в `openspec/changes/server-provisioning/design.md` выбирает контейнер
 * основной целью, а живой стенд — только для приёмки. Здесь лежит всё, что нужно,
 * чтобы поднять такую цель, положить в неё дерево репозитория и выполнить провижининг.
 *
 * Три ограничения названы вслух, а не обойдены молчанием:
 *
 * 1. **bind-mount недоступен** (colima), поэтому файлы кладутся `docker cp`.
 * 2. **systemd в контейнере не работает** как менеджер служб. Вместо него в образе стоит заглушка
 *    `systemctl`, которая записывает вызовы в `/var/log/systemctl-stub.log` и
 *    поднимает nginx обычным процессом. Значит проверяется НЕ поведение systemd, а
 *    факт и состав вызовов плюс наличие и текст `unit`-файла. Тест, которому нужен
 *    настоящий systemd, обязан это сказать, а не считать заглушку доказательством.
 *    **Разбор юнита при этом настоящий:** в образе стоит пакет `systemd` ради
 *    `systemd-analyze verify`, который читает юнит теми же правилами, что и сервер.
 *    Это закрывает класс, который заглушка не видит по устройству: директива в неверной
 *    секции systemd не отвергается, а МОЛЧА игнорируется, и сверка текста юнита с
 *    ожидаемым такой юнит считает верным.
 * 3. **транспорт до цели — заглушка `ssh`.** `scripts/bootstrap-vps.sh` ходит на хост
 *    по ssh; внутри контейнера `/usr/bin/ssh` подменён на исполнение полезной нагрузки
 *    локально. Проверяется тело провижининга, а не транспорт.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Тег меняется вместе с составом образа: закэшированный образ прежнего состава иначе
// молча используется дальше, и новая проверка не выполняется вовсе.
export const IMAGE = 'ikpk-provision-target:test-systemd';

/**
 * Архитектура образа приравнивается к архитектуре ХОЗЯИНА. Без этого docker тянет образ
 * по умолчанию реестра — на arm64-машине это оказался x86_64, и весь набор пошёл через
 * эмуляцию qemu: один сценарий занял 17 минут вместо секунд, а прогон стал неотличим от
 * зависшего. Скорость здесь не удобство: набор, который не дожидаются, не выполняется.
 */
const HOST_ARCH = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
const PLATFORM = ['--platform', HOST_ARCH];

export type Run = { status: number; stdout: string; stderr: string; output: string };

function docker(args: string[], opts: { input?: string; timeout?: number } = {}): Run {
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`docker ${args.slice(0, 2).join(' ')} не запустился: ${res.error.message}`);
  }
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return { status: res.status ?? -1, stdout, stderr, output: `${stdout}${stderr}` };
}

function dockerOrThrow(args: string[], opts?: { input?: string; timeout?: number }): Run {
  const run = docker(args, opts);
  if (run.status !== 0) {
    throw new Error(`docker ${args.join(' ')} → код ${run.status}\n${run.output}`);
  }
  return run;
}

/** Отсутствие docker — «измерить не удалось», а не «нарушений нет». Падаем громко. */
export function requireDocker(): void {
  const run = docker(['version', '--format', '{{.Server.Version}}']);
  if (run.status !== 0) {
    throw new Error(
      'Цель проверки недоступна: docker не отвечает. Это НЕ «нарушений нет» — ' +
        `сценарии server-provisioning не измерены.\n${run.output}`,
    );
  }
}

const SSH_SHIM = `#!/bin/bash
# Заглушка транспорта: цель провижининга — сам контейнер.
# Последний аргумент — удалённая команда, stdin — тело удалённого скрипта.
cmd="\${@: -1}"
tmp=$(mktemp)
cat > "$tmp"
if [[ "$cmd" == *"bash -s" ]]; then
  exec bash -c "\${cmd%bash -s}bash $tmp"
fi
exec bash -c "$cmd" < "$tmp"
`;

const SYSTEMCTL_SHIM = `#!/bin/bash
# Заглушка systemd: настоящего systemd в контейнере нет.
# Вызовы записываются, nginx поднимается обычным процессом.
echo "$@" >> /var/log/systemctl-stub.log
case "$1 $2" in
  "reload nginx"|"restart nginx") if pgrep -x nginx >/dev/null; then nginx -s reload; else nginx; fi ;;
  "start nginx") pgrep -x nginx >/dev/null || nginx ;;
  "stop nginx") nginx -s stop || true ;;
esac
exit 0
`;

/**
 * Готовит образ цели. Собирается не `docker build`, а прогоном и `docker commit`:
 * в этой установке (colima, containerd snapshotter) образ классического билдера
 * не находится `docker run`, а закоммиченный находится.
 */
export function ensureImage(): void {
  requireDocker();
  if (docker(['image', 'inspect', IMAGE]).status === 0) return;
  const id = dockerOrThrow(['run', '-d', ...PLATFORM, 'debian:12-slim', 'sleep', '900']).stdout.trim();
  try {
    dockerOrThrow([
      'exec', id, 'bash', '-c',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && ' +
        // systemd ставится ради НАСТОЯЩЕГО systemd-analyze: он разбирает юнит теми же
        // правилами, что и systemd на сервере, и ловит директиву в неверной секции —
        // ровно то, чего заглушка systemctl не видит по устройству.
        'apt-get install -y -qq --no-install-recommends nginx rsync curl iproute2 procps ca-certificates systemd >/dev/null',
    ]);
    dockerOrThrow(['exec', '-i', id, 'bash', '-c', 'cat > /usr/bin/ssh && chmod +x /usr/bin/ssh'], { input: SSH_SHIM });
    dockerOrThrow(['exec', '-i', id, 'bash', '-c', 'cat > /usr/bin/systemctl && chmod +x /usr/bin/systemctl'], {
      input: SYSTEMCTL_SHIM,
    });
    dockerOrThrow(['commit', id, IMAGE]);
  } finally {
    docker(['rm', '-f', id]);
  }
}

export class ProvisionTarget {
  private constructor(readonly id: string) {}

  static start(): ProvisionTarget {
    ensureImage();
    const id = dockerOrThrow(['run', '-d', ...PLATFORM, IMAGE, 'sleep', '1800']).stdout.trim();
    const target = new ProvisionTarget(id);
    target.copyRepoDir('scripts');
    target.copyRepoDirIfExists('deploy');
    return target;
  }

  /** Второй контейнер той же сети — «снаружи». Netns не разделяется с целью. */
  static probe(command: string): Run {
    ensureImage();
    return docker(['run', '--rm', ...PLATFORM, IMAGE, 'bash', '-lc', command], { timeout: 60_000 });
  }

  /** Наблюдатель снаружи, работающий во время провижининга. Возвращает id. */
  static startProbe(command: string): string {
    ensureImage();
    return dockerOrThrow(['run', '-d', ...PLATFORM, IMAGE, 'bash', '-lc', command]).stdout.trim();
  }

  static probeOutput(id: string): string {
    return docker(['logs', id]).output;
  }

  static stopProbe(id: string): void {
    docker(['rm', '-f', id]);
  }

  get ip(): string {
    return dockerOrThrow([
      'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', this.id,
    ]).stdout.trim();
  }

  exec(command: string, env: Record<string, string> = {}): Run {
    const args = ['exec'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(this.id, 'bash', '-lc', command);
    return docker(args);
  }

  execOrThrow(command: string, env: Record<string, string> = {}): string {
    const run = this.exec(command, env);
    if (run.status !== 0) throw new Error(`в контейнере упало: ${command}\n${run.output}`);
    return run.stdout;
  }

  read(path: string): string | null {
    const run = this.exec(`cat ${JSON.stringify(path)}`);
    return run.status === 0 ? run.stdout : null;
  }

  write(path: string, content: string): void {
    dockerOrThrow(['exec', '-i', this.id, 'bash', '-lc', `mkdir -p "$(dirname ${JSON.stringify(path)})" && cat > ${JSON.stringify(path)}`], {
      input: content,
    });
  }

  copyRepoDir(rel: string): void {
    this.exec('mkdir -p /repo');
    dockerOrThrow(['cp', join(REPO_ROOT, rel), `${this.id}:/repo/${rel}`]);
  }

  copyRepoDirIfExists(rel: string): boolean {
    this.exec('mkdir -p /repo');
    return docker(['cp', join(REPO_ROOT, rel), `${this.id}:/repo/${rel}`]).status === 0;
  }

  /** Прогон провижининга внутри цели. Возвращает код и весь вывод. */
  provision(env: Record<string, string> = {}, script = 'scripts/bootstrap-vps.sh'): Run {
    return this.exec(`bash /repo/${script} target`, {
      SSH_KEY: '/dev/null',
      DOMAIN: 'stand.local',
      ...env,
    });
  }

  stop(): void {
    docker(['rm', '-f', this.id]);
  }
}
