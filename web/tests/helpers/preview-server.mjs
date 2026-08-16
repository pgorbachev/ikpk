// ─── Передний процесс для preview, каким бы ни был astro ────────────────────
//
// Зачем эта обёртка существует. Playwright в `webServer` требует процесс, который
// ЖИВЁТ пока идут тесты: он ждёт порт и следит за процессом, а завершение процесса
// раньше срока считает отказом («Process from config.webServer exited early»).
//
// `astro preview` в 7.1.6 этому соответствовал — держал сервер на переднем плане.
// В 7.2.0 он всегда уходит в фон: печатает `Preview server running at … (pid N)` и
// завершается с кодом 0, оставив демона слушать порт. Флаг `--no-background` этого не
// меняет — проверено. Из-за этого локально перестаёт запускаться всё, что поднимает
// сервер: smoke, a11y, визуальные снимки, compat. В CI то же самое проходит по гонке
// (проверка порта успевает раньше, чем замечено завершение), то есть дефект виден
// только локально — а локальные проверки Actions не заменяют.
//
// Обёртка НЕ выбирает версию: она смотрит, что процесс сделал на самом деле. Остался
// жив — отдаёт ему управление. Завершился, а порт занят — усыновляет демона и держит
// фронт за него, гася на выходе.
//
// ─── Про уборку, без преувеличений ──────────────────────────────────────────
//
// Погасить демона на выходе удаётся НЕ всегда: Playwright снимает процесс webServer
// сигналом, который не перехватывается, и тогда демон переживает прогон. Проверено на
// себе — после прогона остался `pid 92959, background`.
//
// Чем это НЕ является: тихим ложным зелёным. При `reuseExistingServer: false`
// Playwright сам отказывается стартовать на занятом порту — «http://localhost:4322 is
// already used» — то есть переживший демон ломает СЛЕДУЮЩИЙ прогон громко, а не
// подсовывает ему старый `dist`. Первая редакция этого файла утверждала обратное;
// утверждение было неверным.
//
// Что остаётся настоящей проблемой: переживший демон блокирует следующие прогоны, и
// разбираться приходилось бы руками. Снимается это НЕ здесь, а шагом
// `preview-reset.mjs` перед `playwright test`, и причина техническая: Playwright
// проверяет порт сам и до запуска этой команды, поэтому уборка, положенная внутрь
// обёртки, не исполнялась бы никогда — проверено.
//
// Проверка занятого порта ниже оставлена как защита для прямых вызовов обёртки (мимо
// Playwright) и как явное сообщение вместо неясного отказа. В обычном прогоне первым
// отказывает Playwright.

import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '4322'));
// Каким конфигом поднимать сервер. Именно конфиг, а не `--outDir`: у `astro preview`
// флага `--outDir` нет, и он игнорировал его молча (см. astro.demo.config.mjs).
const configPath = arg('config', '');
// Каталог, содержимое которого сервер ОБЯЗАН отдавать. Не выбирает вывод — проверяет
// его после старта. По умолчанию боевой `dist`, потому что таков `outDir` в
// astro.config.mjs, и проверку получают все вызовы, а не только демонстрационный.
const outDir = arg('outDir', 'dist');

const fail = (message) => {
  console.error(`preview-server: ${message}`);
  process.exit(1);
};

/** Отвечает ли кто-нибудь на порту. Одна попытка, без ожидания. */
const portBusy = () =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });

const waitForPort = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portBusy()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const waitForPortFree = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portBusy())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/**
 * Сообщает ли astro о СВОЁМ фоновом сервере. Состояние держится в каталоге проекта,
 * поэтому ответ относится к этому worktree, а не к любому preview на машине.
 * `astro preview status` в 7.1.6 отсутствует — тогда своего демона быть и не может.
 */
const ownDaemonRunning = () => {
  const r = spawnSync('npx', ['astro', 'preview', 'status'], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return /Preview server running/i.test(out);
};

// ─── Предполётная уборка ────────────────────────────────────────────────────
if (await portBusy()) {
  if (ownDaemonRunning()) {
    console.log('preview-server: найден свой фоновый preview от прошлого прогона, гашу');
    spawnSync('npx', ['astro', 'preview', 'stop'], { stdio: 'inherit' });
    if (!(await waitForPortFree(10_000))) {
      fail(`свой демон погашен, но ${host}:${port} всё ещё занят — разбирать руками`);
    }
  } else {
    fail(
      `порт ${host}:${port} занят, и astro о своём фоновом сервере не сообщает — значит ` +
        `это посторонний сервер. Прогон над его содержимым был бы прогоном над ` +
        `неизвестным dist, поэтому отказ. Освободить порт и повторить.`,
    );
  }
}

// ─── Запуск ─────────────────────────────────────────────────────────────────
const previewArgs = ['run', 'preview', '--', '--host', host, '--port', String(port)];
const { existsSync } = await import('node:fs');
if (!existsSync(outDir)) {
  fail(`каталога вывода нет: ${outDir}. Для демо-проекта сначала npm run build:demo`);
}
if (configPath) {
  if (!existsSync(configPath)) {
    fail(`конфигурации нет: ${configPath}`);
  }
  previewArgs.push('--config', configPath);
}

const child = spawn('npm', previewArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
}

let childExited = false;
let childCode = null;
child.on('exit', (code) => {
  childExited = true;
  childCode = code;
});

if (!(await waitForPort(60_000))) {
  if (!childExited) child.kill('SIGTERM');
  fail(`сервер не начал слушать ${host}:${port} за 60 с`);
}

// Порт поднялся. Дальше важно, жив ли процесс: от этого зависит, кто держит фронт.
await new Promise((r) => setTimeout(r, 300));

let adoptedPid = null;

if (childExited) {
  // Поведение 7.2.0: сервер в фоне, передний процесс ушёл.
  if (output.includes('already running')) {
    fail(
      'astro сообщил «Preview server already running» уже после предполётной уборки — ' +
        'состояние на порту меняется под нами, разбирать руками.',
    );
  }
  const m = output.match(/\(pid (\d+)/);
  adoptedPid = m ? Number(m[1]) : null;
  if (adoptedPid === null) {
    fail(
      `процесс preview завершился (код ${childCode}), порт занят, но pid демона в выводе ` +
        `не найден. Вывод:\n${output}`,
    );
  }
  console.log(`preview-server: усыновлён фоновый preview, pid ${adoptedPid}`);
} else {
  console.log('preview-server: preview держится на переднем плане');
}

// ─── Уборка на выходе (лучшее усилие) ───────────────────────────────────────
// Сработает при SIGINT/SIGTERM и обычном завершении. При неперехватываемом сигнале не
// сработает — на этот случай и заведена предполётная уборка выше.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;

  if (adoptedPid !== null) {
    try {
      process.kill(adoptedPid, 'SIGTERM');
    } catch {
      // Уже мёртв — гасить нечего.
    }
    spawnSync('npx', ['astro', 'preview', 'stop'], { stdio: 'ignore' });
  } else if (!childExited) {
    child.kill(signal === 'exit' ? 'SIGTERM' : signal);
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdown(signal);
    process.exit(0);
  });
}
process.on('exit', () => shutdown('exit'));

// ─── Проверка: сервер отдаёт ИМЕННО тот каталог, ради которого поднят ────────
//
// Зачем она нужна. Выбор каталога делает конфигурация astro, а не эта обёртка, и
// ошибка в выборе не проявляется ничем: сервер поднимается, порт отвечает, страницы
// приходят — просто не те. Ровно так демо-прогон Playwright полгода проверял бы
// боевую сборку, отчитываясь зелёным. Проверка сравнивает то, что отдал сервер, с
// файлом на диске: расхождение — отказ, а не молчание.
//
// Регистрируется ПОСЛЕ обработчиков уборки: отказ уходит через `fail` → `exit`, и
// поднятый демон гасится, а не остаётся ломать следующий прогон.
{
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  let served;
  try {
    const res = await fetch(`http://${host}:${port}/`);
    if (!res.ok) fail(`сервер ответил ${res.status} на «/» — проверить содержимое нечем`);
    served = await res.text();
  } catch (err) {
    fail(`не удалось прочитать «/» с ${host}:${port}: ${err}`);
  }
  const expected = readFileSync(join(outDir, 'index.html'), 'utf8');
  if (served !== expected) {
    fail(
      `сервер на ${host}:${port} отдаёт НЕ ${outDir}: «/» разошлось с ${join(outDir, 'index.html')} ` +
        `(отдано ${served.length} байт, на диске ${expected.length}). Прогон над чужим выводом ` +
        `выглядел бы обычным зелёным, поэтому отказ. Проверить --config и outDir в нём.`,
    );
  }
  console.log(`preview-server: отдаётся ${outDir} — сверено по «/»`);
}

// Держим фронт. Playwright снимет этот процесс сам, когда тесты кончатся.
if (adoptedPid !== null) {
  setInterval(() => {}, 1 << 30);
} else {
  child.on('exit', (code) => process.exit(code ?? 0));
}
