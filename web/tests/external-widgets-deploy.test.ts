import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEL_CHAT_FACADE } from './helpers/external-widgets';

const execFileAsync = promisify(execFile);

/**
 * Тесты по спеке change `external-widgets` — гейт ВЫКЛАДКИ.
 *
 * Предмет — функции `scripts/lib/deploy-checks.sh` на фикстурных каталогах. Ни боевой,
 * ни демо-вывод здесь не читаются: инвариант «ровно один предмет» соблюдён по
 * построению, каталоги временные.
 *
 * ── ЧТО ИМЕННО ЛОВИТ ЭТОТ ФАЙЛ ──────────────────────────────────────────────
 * Спека требует различать **ссылку формы заявки** и **адрес загрузчика виджета** по
 * НАЗНАЧЕНИЮ, а не по домену, и делать это разбором разметки. Признак назначения к
 * моменту сравнения сегодня уже уничтожен: имя атрибута срезается до отбора кандидатов
 * (`scripts/lib/deploy-checks.sh:514`, `s/^[^=]*=`), и до сравнения
 * доходит только строка адреса — без элемента, без атрибута, без контекста.
 *
 * Отсюда два тихих исхода, между которыми надо не попасть, и оба проверяются ПОИМЁННО:
 *
 *  - адрес загрузчика попал в извлечение → боевая выкладка заблокирована законной
 *    сборкой;
 *  - адрес загрузчика в извлечение не попал → проверка его не видит, и живой чат уедет
 *    на стенд незамеченным.
 *
 * Мутация, меняющая только имя атрибута на `data-*-src`, воспроизводит ПЕРВЫЙ исход и
 * НЕ воспроизводит второй — то есть проходит, не убрав предмет. Различать обязательно.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'scripts', 'lib', 'deploy-checks.sh');

/** Портал заказчика — ссылки форм заявки. */
const CUSTOMER = 'https://b24-cbqwqo.bitrix24site.ru';
/**
 * Адрес загрузчика чата на НЕпортальном поддомене того же домена.
 *
 * Значение выбрано как ПРОБА, а не как утверждение о живом сервисе: спека прямо
 * говорит, что где живёт адрес загрузчика — не известно, и запрещает утверждать это без
 * замера. Проба нужна, потому что требование обязано покрывать оба случая, и именно этот
 * даёт исход «законная сборка заблокирована».
 */
const LOADER_OFF_PORTAL = 'https://cdn-ru.bitrix24.ru/b00000/crm/site_button/loader_1_abcdef.js';
/** Тот же адрес, но на портальном поддомене — второй из двух покрываемых случаев. */
const LOADER_ON_PORTAL = `${CUSTOMER}/upload/crm/site_button/loader_1_abcdef.js`;

function distRaw(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-widgets-deploy-'));
  for (const [rel, body] of Object.entries(pages)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `<!doctype html><html lang="ru"><body>\n${body}\n</body></html>\n`);
  }
  return dir;
}

type Run = { code: number; stdout: string; stderr: string };

async function sh(call: string): Promise<Run> {
  const script = `set -uo pipefail; source '${LIB}'; ${call}`;
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', script]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const formLinks = (dir: string, mode: string, demo = ''): Promise<Run> =>
  sh(`form_links_match_mode '${dir}' '${mode}' '${demo}'`);

/**
 * Симметричный контроль встраивания чата на выкладке — ШОВ, выбранный этими тестами.
 *
 * Спека требует: «выкладка боевого сайта SHALL проверять соответствие встраивания чата
 * ожидаемому для режима — тем же способом, которым она уже проверяет ссылки форм и
 * платёжный эндпоинт». Имя и порядок аргументов взяты по образцу
 * `payment_endpoint_matches <dist> <expect> <mode>`.
 */
const chatWidget = (dir: string, mode: string, expect_ = ''): Promise<Run> =>
  sh(`chat_widget_matches_mode '${dir}' '${mode}' '${expect_}'`);

describe('гейт выкладки различает ссылку формы и загрузчик виджета', () => {
  it('загрузчик виджета в боевой сборке не принят за ссылку формы', async () => {
    // Исход «законная сборка заблокирована». Ссылки форм в боевой сборке правильные,
    // единственное, что может не понравиться гейту, — адрес загрузчика.
    const dir = distRaw({
      'index.html':
        `<a href="${CUSTOMER}/news/">Записаться</a>\n` +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await formLinks(dir, 'prod', '');
    expect(
      run.code,
      `гейт отверг боевую выкладку из-за адреса загрузчика:\n${run.stderr}`,
    ).toBe(0);
  });

  it('загрузчик на ПОРТАЛЬНОМ поддомене боевую выкладку тоже не отвергает', async () => {
    // Второй покрываемый случай. Если фактический адрес окажется портальным, он
    // ожиданию боевого режима соответствует, и первый исход не существует вовсе —
    // поэтому оба проверяются, а не выбирается один «по общему знанию».
    const dir = distRaw({
      'index.html':
        `<a href="${CUSTOMER}/news/">Записаться</a>\n` +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_ON_PORTAL}"></div>`,
    });
    const run = await formLinks(dir, 'prod', '');
    expect(run.code, run.stderr).toBe(0);
  });

  it('загрузчик в атрибуте, чьё имя кончается на `src`, боевую выкладку не отвергает', async () => {
    // ИЗМЕРЕНО, а не предположено: имя атрибута обязано ЗАКАНЧИВАТЬСЯ на href/src/action
    // непосредственно перед знаком равенства, и тогда значение попадает в извлечение.
    // Проверено прогоном существующего выражения на этом же дереве: с `data-chat-src`
    // гейт отвергает боевую выкладку (код 1, «Ссылки форм не соответствуют режиму prod»),
    // с `data-chat-loader` — не видит адрес вовсе.
    //
    // Отсюда практическое следствие, обратное интуиции: приём, на который change
    // ссылается как на образец, называется `data-map-src`, то есть реализация, идущая за
    // образцом, попадает в исход с ЗАБЛОКИРОВАННОЙ выкладкой. Признак назначения обязан
    // судить по разбору разметки, а не по имени атрибута, — тогда исход не зависит от
    // того, как назван носитель.
    const dir = distRaw({
      'index.html':
        `<a href="${CUSTOMER}/news/">Записаться</a>\n` +
        `<div ${SEL_CHAT_FACADE} data-chat-src="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await formLinks(dir, 'prod', '');
    expect(
      run.code,
      'боевая выкладка заблокирована законной сборкой: адрес загрузчика принят за ссылку ' +
        `формы только из-за имени атрибута:\n${run.stderr}`,
    ).toBe(0);
  });

  it('живая ссылка формы на стенде по-прежнему ловится', async () => {
    // Обратная сторона: расширение гейта под загрузчик не имеет права ослабить его
    // основную работу. Это и есть страховка от лечения «просто расширить шаблон».
    const dir = distRaw({
      'index.html':
        '<a href="/demo-zayavka">Записаться</a>\n' +
        `<a href="${CUSTOMER}/news/">Подписаться</a>`,
    });
    const run = await formLinks(dir, 'stand', 'stub');
    expect(run.code, 'живая ссылка в CRM заказчика прошла на стенд').toBe(1);
    expect(run.stderr).toContain('/news/');
  });

  it('стенд с одними заглушками и загрузчиком чата проходит', async () => {
    const dir = distRaw({
      'index.html':
        '<a href="/demo-zayavka">Записаться</a>\n' +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await formLinks(dir, 'stand', 'stub');
    expect(run.code, `загрузчик чата отвергнут на стенде:\n${run.stderr}`).toBe(0);
  });

  it('ссылка формы в АТРИБУТЕ ДАННЫХ гейту видна', async () => {
    // Исход «слепой гейт». Имя атрибута не заканчивается на href/src/action, поэтому
    // сегодняшнее извлечение не видит его ВОВСЕ — измерено: `data-chat-src`
    // извлекается, `data-chat-loader` нет. Признак обязан судить по назначению, а не по
    // тому, каким атрибутом адрес записан.
    const dir = distRaw({
      'index.html':
        '<a href="/demo-zayavka">Записаться</a>\n' +
        `<button data-form-link="${CUSTOMER}/crm_form_ve1op/">Записаться</button>`,
    });
    const run = await formLinks(dir, 'stand', 'stub');
    expect(
      run.code,
      'ссылка формы в атрибуте данных прошла мимо гейта: живой лид в CRM заказчика ' +
        'с показа, при зелёной проверке',
    ).toBe(1);
  });

  it('проза со `src=` внутри абзаца ссылкой не считается', async () => {
    // Обратная ошибка того же класса: извлечение построчное и идёт по сырому тексту,
    // поэтому в набор попадает проза. Разбор разметки её не подхватывает, регулярка —
    // подхватывает вместе с обрывком разметки.
    const dir = distRaw({
      'index.html':
        '<a href="/demo-zayavka">Записаться</a>\n' +
        '<p>Атрибут src= указывает адрес; в демо он ведёт на /demo-zayavka.</p>',
    });
    const run = await formLinks(dir, 'stand', 'stub');
    expect(run.code, `проза принята за ссылку:\n${run.stderr}`).toBe(0);
  });
});

describe('выкладка боевого сайта проверяет встраивание чата', () => {
  it('боевой вывод без встраивания чата выкладку не проходит, и несоответствие названо', async () => {
    const dir = distRaw({ 'index.html': `<a href="${CUSTOMER}/news/">Записаться</a>` });
    const run = await chatWidget(dir, 'prod', LOADER_OFF_PORTAL);
    expect(run.code, 'выкладка боевого сайта без чата прошла молча').toBe(1);
    expect(
      run.stderr,
      'несоответствие не названо: сообщения о чате в выводе проверки нет',
    ).toMatch(/чат/i);
  });

  it('боевой вывод с ожидаемым адресом загрузчика проходит', async () => {
    const dir = distRaw({
      'index.html':
        `<a href="${CUSTOMER}/news/">Записаться</a>\n` +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await chatWidget(dir, 'prod', LOADER_OFF_PORTAL);
    expect(run.code, run.stderr).toBe(0);
  });

  it('боевой вывод с ЧУЖИМ адресом загрузчика выкладку не проходит', async () => {
    // У заказчика два портала: молчаливый выбор одного направил бы обращения не туда,
    // поэтому проверка сверяет адрес, а не только его наличие.
    const dir = distRaw({
      'index.html':
        `<a href="${CUSTOMER}/news/">Записаться</a>\n` +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_ON_PORTAL}"></div>`,
    });
    const run = await chatWidget(dir, 'prod', LOADER_OFF_PORTAL);
    expect(run.code, 'адрес загрузчика не тот, а выкладка прошла').toBe(1);
  });

  it('на стенде встраивания чата быть не должно, и живое встраивание выкладку не проходит', async () => {
    // Выкладываемый стенд идёт из БОЕВОГО каталога, собранного с заглушкой форм, то
    // есть встраивания в нём нет по признаку демо. Живое встраивание там означает
    // расхождение двух признаков — состояние «формы погашены, чат живой».
    const dir = distRaw({
      'index.html':
        '<a href="/demo-zayavka">Записаться</a>\n' +
        `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await chatWidget(dir, 'stand', LOADER_OFF_PORTAL);
    expect(run.code, 'живой чат уехал на стенд при зелёной проверке').toBe(1);
  });

  it('стенд без встраивания чата проходит', async () => {
    const dir = distRaw({ 'index.html': '<a href="/demo-zayavka">Записаться</a>' });
    const run = await chatWidget(dir, 'stand', LOADER_OFF_PORTAL);
    expect(run.code, run.stderr).toBe(0);
  });

  it('каталога нет — «проверить не удалось», а не «всё верно»', async () => {
    const run = await chatWidget(join(tmpdir(), 'ikpk-widgets-nope'), 'prod', LOADER_OFF_PORTAL);
    expect(run.code, 'на отсутствующем каталоге проверка прошла').toBe(1);
  });

  it('неизвестный режим — отказ, а не молчаливое умолчание', async () => {
    const dir = distRaw({ 'index.html': '<a href="/demo-zayavka">x</a>' });
    const run = await chatWidget(dir, 'ci', LOADER_OFF_PORTAL);
    expect(run.code, 'неизвестный режим принят').toBe(1);
  });

  it('ожидаемый адрес не задан — отказ, а не проход', async () => {
    // Fail-closed: без ожидания сверять нечего, и «нечего сверять» не равно «сошлось».
    const dir = distRaw({
      'index.html': `<div ${SEL_CHAT_FACADE} data-chat-loader="${LOADER_OFF_PORTAL}"></div>`,
    });
    const run = await chatWidget(dir, 'prod', '');
    expect(run.code, 'проверка прошла без ожидаемого адреса').toBe(1);
  });
});
