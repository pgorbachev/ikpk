/**
 * Восстановление контента свёрнутых секций с живого сайта.
 *
 * Зачем: на ikpk.su аккордеоны сделаны на Radix Collapsible, который НЕ
 * монтирует закрытую панель в DOM. Обычный HTTP-скрейп (discovery/) поэтому
 * забрал только заголовки: «Учебный план», «Как проходит обучение»,
 * «Выдаваемые документы»… — а содержимого не получил. В нашей сборке это
 * видно как 404 секции на 96 страницах, которые раскрываются в пустоту.
 * Контента нет ни в __NEXT_DATA__, ни в discovery/content_dump.json —
 * только в DOM после клика. Значит нужен настоящий браузер.
 *
 * Что делает: открывает каждую затронутую страницу, раскрывает все секции,
 * снимает HTML каждой панели и складывает в
 * discovery/entities/collapsible_panels.json в виде
 *   { "<путь страницы>": { "<заголовок секции>": "<html панели>" } }
 *
 * Запуск из web/ (playwright стоит там):
 *   node scripts/recover-collapsibles.mjs [--limit N] [--concurrency N]
 *
 * Идемпотентен: повторный запуск дописывает и обновляет файл, уже собранные
 * страницы пропускаются, если не передан --force. Сеть ненадёжна, поэтому
 * прогресс сохраняется по ходу, а не одним куском в конце.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/**
 * Список адресов для обхода. Путь задаётся аргументом `--targets=<файл>`; по
 * умолчанию — `discovery/collapsible_targets.json`, который лежит в репозитории.
 *
 * Прежде путь был жёстко задан как `scratch-empty.json` — черновой файл, которого
 * в репозитории нет: из чистого checkout скрипт падал на чтении, то есть
 * восстановление 401 секции было невоспроизводимо, а сами секции существовали
 * только в чьём-то рабочем дереве.
 */
const targetsArg = process.argv.find((a) => a.startsWith('--targets='));
const TARGETS = resolve(
  ROOT,
  targetsArg ? targetsArg.slice('--targets='.length) : 'discovery/collapsible_targets.json',
);
const OUT = resolve(ROOT, 'discovery/entities/collapsible_panels.json');
const ORIGIN = 'https://ikpk.su';

/**
 * Часть страниц на живом сайте переехала под другого родителя, а наш дамп
 * снят до переезда. Чтобы забрать контент, ходим по живому адресу, сохраняя
 * данные под нашим путём (сам переезд закрывается 301-редиректом, Этап 1).
 */
const LIVE_ALIASES = {
  '/institut-klinicheskoy-prikladnoy-kineziologii/psihokineziologiya/strahi-i-fobii-fap':
    '/institut-klinicheskoy-prikladnoy-kineziologii/avtorskie-seminary-zharovoj-ls/strahi-i-fobii-fap',
};

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const force = args.includes('--force');
const limit = flag('limit', Infinity);
const concurrency = flag('concurrency', 4);

if (!existsSync(TARGETS)) {
  console.error(`нет файла со списком адресов: ${TARGETS}`);
  console.error('Укажите свой: --targets=<путь к json со списком путей>');
  process.exit(1);
}
const targets = JSON.parse(readFileSync(TARGETS, 'utf-8'));
if ((Array.isArray(targets) ? targets.length : Object.keys(targets).length) === 0) {
  console.error(`список адресов пуст: ${TARGETS} — обходить нечего`);
  process.exit(1);
}
const collected = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf-8')) : {};

// Список адресов — массив путей. `Object.keys` на массиве даёт индексы
// ('0','1',…), и первая редакция этой правки именно так и ходила бы — за
// `https://ikpk.su/0`. Прежний черновой файл был объектом `{путь: [...]}`, поэтому
// принимаем оба вида: форма данных и обход обязаны совпадать, а не совпадать по
// случайности.
const targetPaths = Array.isArray(targets) ? targets : Object.keys(targets);
if (!targetPaths.every((p) => typeof p === 'string' && p.startsWith('/'))) {
  console.error(`в ${TARGETS} ожидались пути вида "/adres" — обходить нечего`);
  process.exit(1);
}
const paths = targetPaths.filter((p) => force || !collected[p]).slice(0, limit);

console.log(
  `страниц к обработке: ${paths.length} из ${Object.keys(targets).length}` +
    (paths.length < Object.keys(targets).length ? ' (остальные уже собраны)' : ''),
);

const save = () => {
  // tmp+rename: если процесс убьют на середине записи, файл не побьётся
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(collected, null, 1), 'utf-8');
  renameSync(tmp, OUT);
};

/**
 * Снимает содержимое всех секций и возвращает {заголовок: html}.
 *
 * Важно: секции ведут себя как аккордеон одиночного раскрытия — открытие
 * следующей закрывает предыдущую, а Radix при закрытии размонтирует панель.
 * Поэтому раскрываем строго по одной: открыть → снять → закрыть.
 */
async function extract(page) {
  // Колбэк ниже исполняется В СТРАНИЦЕ, а не в Node: document и setTimeout там
  // существуют. Для ESLint, который разбирает файл как node-скрипт, объявляем
  // document точечно — включать browser-окружение на весь файл нельзя, иначе
  // потеряем проверку node-части. setTimeout объявлять не нужно: он есть и в Node.
  /* global document */
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const triggers = [...document.querySelectorAll('button[class*="collapsible_trigger"]')];
    const result = {};

    for (const t of triggers) {
      const title = t
        .querySelector('[data-collapsible-title], h2, h3')
        ?.textContent?.trim();
      if (!title) continue;

      if (t.getAttribute('aria-expanded') !== 'true') {
        t.click();
        await sleep(350);
      }

      const id = t.getAttribute('aria-controls');
      let panel = id ? document.getElementById(id) : null;
      if (!panel) {
        const sib = t.parentElement?.nextElementSibling;
        if (sib && !sib.matches('button')) panel = sib;
      }
      const html = panel?.innerHTML?.trim();
      if (html) result[title] = html;

      // закрываем за собой, чтобы соседние секции не размонтировались
      if (t.getAttribute('aria-expanded') === 'true') {
        t.click();
        await sleep(120);
      }
    }
    return result;
  });
}

const browser = await chromium.launch();
let done = 0;
let empty = 0;
const failures = [];

/** Обрабатывает свою долю очереди; воркеров запускаем несколько параллельно. */
async function worker(queue) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // картинки и шрифты не нужны — экономим время и трафик
  await page.route('**/*', (route) =>
    ['image', 'font', 'media'].includes(route.request().resourceType())
      ? route.abort()
      : route.continue(),
  );

  for (;;) {
    const path = queue.shift();
    if (!path) break;

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const resp = await page.goto(ORIGIN + (LIVE_ALIASES[path] ?? path), {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        if (!resp || resp.status() >= 400) {
          throw new Error(`http ${resp?.status()}`);
        }
        await page
          .waitForSelector('button[class*="collapsible_trigger"]', { timeout: 20_000 })
          .catch(() => {});

        const panels = await extract(page);
        const found = Object.keys(panels).length;
        // Ноль панелей — это НЕ успех. Прежде такой результат сохранялся и на
        // следующем прогоне страница пропускалась как уже обработанная: пустая
        // выдача навсегда закреплялась вместо содержимого. Считаем попыткой и
        // повторяем, а по итогам обхода завершаемся ненулевым кодом.
        if (found === 0) {
          empty++;
          throw new Error('ни одной панели не найдено (страница не сохранена)');
        }

        collected[path] = panels;
        save();
        ok = true;
        done++;
        console.log(
          `[${done}/${paths.length}] ${path} — секций: ${found}/${targets[path].length}`,
        );
      } catch (err) {
        if (attempt === 3) {
          failures.push({ path, error: String(err.message || err) });
          console.log(`[!] ${path} — не удалось: ${err.message || err}`);
        } else {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
  }

  await ctx.close();
}

const queue = [...paths];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, () => worker(queue)),
);
await browser.close();

const sections = Object.values(collected).reduce((n, v) => n + Object.keys(v).length, 0);
console.log(
  `\nготово. страниц в файле: ${Object.keys(collected).length}, секций собрано: ${sections}`,
);
if (empty) console.log(`страниц, где не нашлось ни одной панели: ${empty}`);
if (failures.length) {
  console.log(`не удалось (${failures.length}):`);
  for (const f of failures) console.log(`  ${f.path}: ${f.error}`);
}
// Незакрытые страницы и нулевые выдачи — результат «не выполнено», а не «дефектов
// нет»: с кодом 0 вызывающий продолжал бы работу на неполных данных.
if (failures.length || sections === 0) {
  console.error(
    `\nвосстановление не завершено: страниц с ошибкой ${failures.length}, секций собрано ${sections}`,
  );
  process.exit(1);
}
