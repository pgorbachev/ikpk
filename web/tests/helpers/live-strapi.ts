/**
 * Живой Strapi для проверок редактируемости.
 *
 * ШОВ — HTTP content-manager API, тот самый, которым пользуется админка. Ниже него
 * не опускаемся намеренно: статическая сверка схем доказывает структуру, но не то,
 * что редактор может сохранить запись. Эти два предмета разошлись на `status`, где
 * схема была безупречна, а сохранение отказывало.
 *
 * Процессом, а не контейнером: `cms/node_modules` весит 827 МБ, и копирование их в
 * контейнер на каждый прогон стоит минуты. Изоляция обеспечивается иначе — свой порт
 * и своя временная база на каждый запуск.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CMS = join(import.meta.dirname, '..', '..', '..', 'cms');

export interface LiveStrapi {
  base: string;
  token: string;
  stop(): void;
}

const key = () => randomBytes(16).toString('base64');

async function waitFor(url: string, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (r.status < 500) return;
    } catch {
      // служба ещё поднимается
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Strapi не поднялся за ${deadlineMs} мс: ${url}. Это «измерить не удалось», а не «дефектов нет»`);
}

/**
 * Схемы из `src` в `dist` — иначе тест проверяет ПРОШЛУЮ сборку.
 *
 * Найдено негативной проверкой: возврат дефекта (`entry_status` → `status`) в исходниках
 * оставлял тест зелёным, потому что `strapi start` читает `dist/src/api/**\/schema.json`,
 * а мутация правила `src`. Проверка измеряла артефакт двухчасовой давности и была
 * декоративной. Схемы — обычный JSON, читаемый при старте, компиляция им не нужна,
 * поэтому достаточно перенести их поверх собранных.
 *
 * Отсутствие собранного дерева — отказ, а не «нарушений нет»: без него проверять нечего.
 */
function syncSchemas(): void {
  const src = join(CMS, 'src', 'api');
  const dist = join(CMS, 'dist', 'src', 'api');
  if (!existsSync(dist)) {
    throw new Error(`нет собранного дерева ${dist}: сначала \`npm run build\` в cms/. Это «измерить не удалось»`);
  }
  let copied = 0;
  for (const type of readdirSync(src, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    const rel = join(type.name, 'content-types', type.name, 'schema.json');
    const from = join(src, rel);
    const to = join(dist, rel);
    if (existsSync(from) && existsSync(to)) {
      copyFileSync(from, to);
      copied += 1;
    }
  }
  if (copied === 0) throw new Error('ни одной схемы не перенесено — проверять нечего');
}

/** Поднимает Strapi на своём порту и заводит первого администратора. */
export async function startStrapi(bootMs = 180_000): Promise<LiveStrapi> {
  syncSchemas();
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-strapi-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(
    process.execPath,
    ['node_modules/@strapi/strapi/bin/strapi.js', 'start'],
    {
      cwd: CMS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_CLIENT: 'sqlite',
        DATABASE_FILENAME: join(dir, 'test.db'),
        APP_KEYS: `${key()},${key()}`,
        API_TOKEN_SALT: key(),
        ADMIN_JWT_SECRET: key(),
        TRANSFER_TOKEN_SALT: key(),
        JWT_SECRET: key(),
        ENCRYPTION_KEY: randomBytes(16).toString('hex'),
        STRAPI_TELEMETRY_DISABLED: 'true',
        STRAPI_DISABLE_UPDATE_NOTIFICATION: 'true',
      },
    },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill('SIGTERM');
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // временный каталог мог уже исчезнуть
    }
  };
  try {
    await waitFor(`${base}/admin/init`, bootMs);
  } catch (err) {
    stop();
    throw new Error(`${(err as Error).message}\n--- вывод Strapi ---\n${log.slice(-1500)}`, { cause: err });
  }

  // Первый администратор: на пустой базе этот маршрут открыт.
  const password = `Aa1!${randomBytes(9).toString('hex')}`;
  const res = await fetch(`${base}/admin/register-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@ikpk.local', password, firstname: 'Test', lastname: 'Admin' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    stop();
    throw new Error(`не удалось завести администратора: ${res.status} ${await res.text()}`);
  }
  const token = ((await res.json()) as { data: { token: string } }).data.token;
  return { base, token, stop };
}
