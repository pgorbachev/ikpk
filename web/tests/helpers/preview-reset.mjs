// ─── Снять свой фоновый preview перед прогоном ───────────────────────────────
//
// Почему это отдельный шаг, а не часть `preview-server.mjs`. Playwright проверяет
// порт САМ и до запуска `webServer.command`: при `reuseExistingServer: false` он
// отказывается сразу — «http://localhost:4322 is already used» — и команду не
// запускает вовсе. Проверено: уборка, положенная внутрь обёртки, не исполнялась
// никогда. Поэтому она живёт здесь и вызывается ДО `playwright test`.
//
// Зачем она нужна. `astro preview` с 7.2.0 всегда уходит в фон, а Playwright снимает
// процесс `webServer` неперехватываемым сигналом — значит демон переживает прогон
// (проверено: после прогона остаётся `pid …, background`). Сам по себе он не опасен:
// следующий прогон падает громко, а не идёт над старым `dist`. Но падает он на каждом
// запуске, пока демона не погасят руками, — вот это и снимается здесь.
//
// Гасится ТОЛЬКО свой демон: состояние `astro preview` лежит в каталоге проекта,
// поэтому `status` отвечает про этот worktree. Чужой сервер на том же порту не
// трогается — про него честнее упасть, чем убить его молча.

import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const host = '127.0.0.1';
const port = Number(process.env.PREVIEW_PORT ?? '4322');

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

if (!(await portBusy())) {
  process.exit(0);
}

const status = spawnSync('npx', ['astro', 'preview', 'status'], { encoding: 'utf8' });
const out = `${status.stdout ?? ''}${status.stderr ?? ''}`;

if (!/Preview server running/i.test(out)) {
  console.error(
    `preview-reset: порт ${host}:${port} занят, но astro о своём фоновом сервере не ` +
      `сообщает — значит это посторонний сервер, и гасить его я не буду. Освободить ` +
      `порт и повторить.`,
  );
  process.exit(1);
}

console.log('preview-reset: найден свой фоновый preview от прошлого прогона, гашу');
spawnSync('npx', ['astro', 'preview', 'stop'], { stdio: 'inherit' });

const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  if (!(await portBusy())) process.exit(0);
  await new Promise((r) => setTimeout(r, 200));
}

console.error(`preview-reset: демон погашен, но ${host}:${port} всё ещё занят`);
process.exit(1);
