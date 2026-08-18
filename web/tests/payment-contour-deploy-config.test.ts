/**
 * Матрица контуров: КОНФИГУРАЦИЯ ИНСТАНЦИЙ И ПУТЕЙ ПУБЛИКАЦИИ
 * (задачи 5.10c, 5.10e, 4.10, 6.13a, 6.14).
 *
 * Предмет — конфигурация, лежащая в репозитории: обратный прокси стенда, units инстанций,
 * место вызова гейта. Почему структурная проверка, а не поведенческая: nginx проект в
 * тестах не поднимает (AGENTS.md прямо называет фактический ответ nginx законной ручной
 * проверкой), а systemd-инстанции на VPS из прогона не наблюдаемы. Отсюда граница
 * достоверности названа вслух: эти проверки стерегут ПРОВОДКУ (что маршрут объявлен, что
 * гейт вызывается с ожидаемой ролью), а фактический ответ стенда — предмет приёмки 7.7a.
 *
 * Источник требований (change `online-payment-flow`):
 *  - `specs/online-payment/spec.md`, Requirement «CI/preview не создаёт платежей, а
 *    развёрнутый стенд работает с тестовым магазином»: таблица «объявлено → внешний путь →
 *    процесс», «Сервис SHALL слушать `127.0.0.1:8787` явно»;
 *  - там же, Requirement «Личность контура сообщается несекретным readiness-ответом»:
 *    «`/readyz` наружу не публикуется, и гейт запрашивает его изнутри host»; обратный прокси
 *    отображает наружу лишь создание платежа и проверку статуса;
 *  - там же, Requirement «Установленные платёжные контуры нельзя публиковать выключенными
 *    или перепутанными»: изоляция состояния и секретов `stand` и `prod`; «Гейт SHALL быть
 *    один и SHALL исполняться на каждом пути публикации, который несёт активную платёжную
 *    форму»; «GitHub Pages платёжной поверхностью не является»;
 *  - задача 5.10e: база возврата — свойство контура, `PAYMENT_RETURN_BASE` для стенда;
 *  - задача 6.13a: на пути Pages обязательна проверка, что артефакт собран в роли без формы.
 *
 * ШОВ, ВЫБРАННЫЙ ТЕСТАМИ: конфигурация ищется ПОИСКОМ по каталогам развёртывания
 * (`payments/deploy/`, `deploy/`, `docs/`), а не по заранее названным именам файлов —
 * реализация вольна назвать `stand.conf`, `nginx-stand-api.conf` или расширить
 * существующий `nginx-api.conf`. Жёстко закреплены только значения из спеки:
 * `127.0.0.1:8787`, внешний путь `/api/payments`, `PAYMENT_RETURN_BASE=http://193.124.115.99`.
 *
 * ПОЧЕМУ КРАСНЫЕ СЕЙЧАС: на `ac4089b` `payments/deploy/nginx-api.conf` написан под отдельный
 * host `api.ikpk.su` с `location /`, инстанция ровно одна (`ikpk-payments.service`, один
 * `EnvironmentFile`), явного bind нет нигде, а `PAYMENT_RETURN_BASE` не упомянут ни в одном
 * файле развёртывания — умолчание в коде указывает на боевой сайт.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PAYMENT_RETURN_BASE_STAND,
  READYZ_PATH,
  SERVICE_SHOP_ID,
  STAND_BIND_HOST,
  STAND_BIND_PORT,
  repoRoot,
} from './helpers/payment-contract';

/** Все файлы каталога рекурсивно. Каталога нет — это отказ, а не пустой список. */
function filesUnder(rel: string): string[] {
  const root = join(repoRoot, rel);
  if (!existsSync(root)) {
    throw new Error(`каталога нет: ${rel} — проверка конфигурации не выполнена, а не пройдена`);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  if (out.length === 0) throw new Error(`каталог ${rel} пуст — проверять нечего`);
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function deployFiles(): string[] {
  const dirs = ['payments/deploy'];
  if (existsSync(join(repoRoot, 'deploy'))) dirs.push('deploy');
  return dirs.flatMap(filesUnder);
}

/** Блоки `location … { … }` конфигураций nginx: путь и тело. */
function locations(text: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const re = /location\s+([^{]+?)\s*\{([\s\S]*?)\n\}/g;
  for (const m of text.matchAll(re)) out.push({ path: m[1]!.trim(), body: m[2]! });
  return out;
}

describe('5.10c обратный прокси стенда: наружу открыты только платёжные маршруты', () => {
  const nginxFiles = () => deployFiles().filter((f) => f.endsWith('.conf'));

  it('внешний путь /api/payments отображён на 127.0.0.1:8787', () => {
    const files = nginxFiles();
    expect(files.length, 'конфигураций nginx в каталогах развёртывания нет — предмета нет').toBeGreaterThan(0);
    const matching = files.flatMap((f) =>
      locations(read(f))
        .filter((l) => /\/api\/payments/.test(l.path))
        .map((l) => ({ file: relative(repoRoot, f), ...l })),
    );
    expect(
      matching.length,
      `ни одна конфигурация не объявляет location для /api/payments:\n${files.map((f) => relative(repoRoot, f)).join('\n')}`,
    ).toBeGreaterThan(0);
    for (const l of matching) {
      expect(l.body, `${l.file}: location ${l.path} не проксирует на ${STAND_BIND_HOST}:${STAND_BIND_PORT}`).toMatch(
        new RegExp(`proxy_pass\\s+http://${STAND_BIND_HOST.replace(/\./g, '\\.')}:${STAND_BIND_PORT}`),
      );
    }
  });

  it('проверка статуса попытки тоже проходит через прокси стенда', () => {
    const declared = nginxFiles()
      .flatMap((f) => locations(read(f)).map((l) => l.path))
      .join('\n');
    // Либо один префиксный location покрывает и создание, и статус, либо есть отдельный
    // для `/status`. Требуется, чтобы путь статуса был достижим хоть одним из способов.
    const prefixCovers = /location\s*$|\/api\/payments\s*$|\^~\s*\/api\/payments/.test(declared);
    expect(
      prefixCovers || /\/api\/payments\/.*status/.test(declared),
      `путь проверки статуса не объявлен:\n${declared}`,
    ).toBe(true);
  });

  it(`${READYZ_PATH} наружу не публикуется ни одной конфигурацией`, () => {
    const exposed = nginxFiles()
      .flatMap((f) =>
        locations(read(f))
          .filter((l) => l.path.includes(READYZ_PATH))
          .map((l) => `${relative(repoRoot, f)}: location ${l.path}`),
      );
    expect(exposed, 'readiness открыт наружу — гейт должен спрашивать его изнутри host').toEqual([]);
  });

  it('платёжный API стенда не раздаётся через location / — это увело бы весь origin в сервис', () => {
    const wide = nginxFiles().flatMap((f) =>
      locations(read(f))
        .filter((l) => l.path === '/' && new RegExp(`${STAND_BIND_HOST.replace(/\./g, '\\.')}:${STAND_BIND_PORT}`).test(l.body))
        .map(() => relative(repoRoot, f)),
    );
    expect(wide, 'конфигурация стенда проксирует весь origin в платёжный сервис').toEqual([]);
  });
});

describe('4.10 стенд и production — отдельные инстанции с раздельным состоянием', () => {
  it('объявлены два разных env-файла инстанций (/etc/ikpk-payments/stand.env и prod.env)', () => {
    const refs = new Set<string>();
    for (const f of deployFiles()) {
      for (const m of read(f).matchAll(/\/etc\/ikpk-payments\/[A-Za-z0-9_.-]+\.env/g)) refs.add(m[0]);
    }
    expect([...refs].sort(), `в конфигурации развёртывания найдено: ${[...refs].join(', ') || '(ничего)'}`).toEqual([
      '/etc/ikpk-payments/prod.env',
      '/etc/ikpk-payments/stand.env',
    ]);
  });

  it('каталоги изменяемого состояния у инстанций разные', () => {
    const dirs = new Set<string>();
    for (const f of deployFiles()) {
      for (const m of read(f).matchAll(/\/var\/lib\/ikpk-payments[A-Za-z0-9_./-]*/g)) dirs.add(m[0]);
    }
    const perInstance = [...dirs].filter((d) => /\/(stand|prod)(\/|$)/.test(d));
    expect(perInstance.length, `раздельных каталогов состояния нет: ${[...dirs].join(', ') || '(ничего)'}`).toBeGreaterThanOrEqual(2);
  });

  it(`bind ${STAND_BIND_HOST}:${STAND_BIND_PORT} задан конфигурацией явно, а не умолчанием кода`, () => {
    const text = deployFiles().map(read).join('\n');
    expect(text, 'PAYMENT_LISTEN_HOST не задан в конфигурации инстанции').toMatch(
      new RegExp(`PAYMENT_LISTEN_HOST\\s*=\\s*${STAND_BIND_HOST.replace(/\./g, '\\.')}`),
    );
    expect(text, 'PAYMENT_LISTEN_PORT не задан в конфигурации инстанции').toMatch(
      new RegExp(`PAYMENT_LISTEN_PORT\\s*=\\s*${STAND_BIND_PORT}`),
    );
  });
});

describe('5.10e база возврата — свойство контура и названа в конфигурации стенда', () => {
  it(`PAYMENT_RETURN_BASE=${PAYMENT_RETURN_BASE_STAND} назван в развёртывании стенда`, () => {
    const files = [...deployFiles(), ...filesUnder('docs').filter((f) => f.endsWith('.md'))];
    const hits = files.filter((f) =>
      new RegExp(`PAYMENT_RETURN_BASE[^\\n]*${PAYMENT_RETURN_BASE_STAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(read(f)),
    );
    expect(
      hits.map((f) => relative(repoRoot, f)),
      'ни один файл развёртывания или runbook не называет базу возврата стенда',
    ).not.toEqual([]);
  });

  it('закреплённые магазины контуров названы в конфигурации развёртывания', () => {
    const text = deployFiles().map(read).join('\n');
    expect(text, `тестовый магазин ${SERVICE_SHOP_ID.test} не назван`).toContain(SERVICE_SHOP_ID.test);
    expect(text, `боевой магазин ${SERVICE_SHOP_ID.prod} не назван`).toContain(SERVICE_SHOP_ID.prod);
  });
});

describe('6.13a гейт один, и путь Pages проверяется на роль без активной формы', () => {
  const shellFiles = () =>
    [...filesUnder('scripts')].filter((f) => f.endsWith('.sh'));

  it('функция гейта определена ровно один раз — общий скрипт, а не копия на путь', () => {
    const defs = shellFiles().filter((f) => /^\s*payment_endpoint_matches\s*\(\)/m.test(read(f)));
    expect(defs.map((f) => relative(repoRoot, f))).toEqual(['scripts/lib/deploy-checks.sh']);
  });

  it('разбора платёжной разметки нет за пределами общего скрипта', () => {
    const reimplemented = shellFiles()
      .filter((f) => relative(repoRoot, f) !== 'scripts/lib/deploy-checks.sh')
      .filter((f) => /data-payment-(endpoint|role)/.test(read(f)))
      .map((f) => relative(repoRoot, f));
    expect(reimplemented, 'разметку разбирает кто-то помимо общего гейта').toEqual([]);
  });

  // «/readyz наружу не публикуется, и гейт запрашивает его изнутри host» — предмет здесь
  // МЕСТО ВЫЗОВА, а не разбор ответа (разбор проверяется поведением в
  // `deploy-checks-payment-role.test.ts`). Без этой проверки гейт мог бы спрашивать
  // readiness по публичному адресу, и совпадение адреса подменило бы доказательство
  // личности контура.
  it('readiness запрашивается по внутреннему адресу 127.0.0.1:8787, а не по публичному', () => {
    const calls = shellFiles()
      .flatMap((f) => read(f).split('\n').map((line) => ({ file: relative(repoRoot, f), line })))
      .filter(({ line }) => /readyz|readiness/i.test(line) && !/^\s*#/.test(line));
    expect(
      calls.length,
      'ни один скрипт выкладки не запрашивает readiness — положительного признака контура у гейта нет',
    ).toBeGreaterThan(0);
    for (const { file, line } of calls) {
      if (!/https?:\/\//.test(line)) continue;
      expect(line, `${file}: readiness запрашивается не изнутри host`).toMatch(
        new RegExp(`https?://${STAND_BIND_HOST.replace(/\./g, '\\.')}:${STAND_BIND_PORT}`),
      );
    }
  });

  it('deploy.yml проверяет роль артефакта до публикации Pages', () => {
    const wf = read(join(repoRoot, '.github/workflows/deploy.yml'));
    const uploadAt = wf.indexOf('upload-pages-artifact');
    expect(uploadAt, 'в deploy.yml нет шага публикации артефакта').toBeGreaterThan(-1);
    const before = wf.slice(0, uploadAt);
    expect(before, 'до загрузки артефакта роль не проверяется').toMatch(/data-payment-role|payment_endpoint_matches/);
    expect(before, 'проверка не сослалась на общий скрипт гейта').toMatch(/scripts\/(lib\/)?[A-Za-z0-9_.-]+\.sh/);
  });

  it('deploy.yml не публикует артефакт установленного контура', () => {
    const wf = read(join(repoRoot, '.github/workflows/deploy.yml'));
    expect(wf, 'путь Pages объявляет роль установленного контура').not.toMatch(
      /PAYMENT_ROLE\s*[:=]\s*['"]?(stand|prod)\b/,
    );
  });
});
