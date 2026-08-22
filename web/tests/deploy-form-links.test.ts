import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// Гейт ссылок на формы заявки: `form_links_match_mode` в scripts/lib/deploy-checks.sh.
//
// ЧТО ЛОВИТ ЭТОТ ФАЙЛ. Прежняя редакция гейта отбирала кандидатов ПО ФОРМЕ ПУТИ —
// `href` со словом `crm_form` либо путь заглушки, — а затем требовала от отобранного
// пути опять-таки `crm_form_`. Отбор и признак совпадали, поэтому проверка
// подтверждала собственный выбор и не могла покраснеть по построению: любая ссылка на
// портал заказчика с другим путём в набор не попадала вовсе.
//
// Ссылки с другим путём — не гипотеза. В прод-сборке на 2026-08-22 из 34 различных
// адресов Bitrix24 четыре не содержат `crm_form`:
//   https://b24-cbqwqo.bitrix24site.ru/news/   — 268 страниц из 270 (подписка в футере),
//   https://b24-cbqwqo.bitrix24site.ru/umac1/  — 2 страницы,
//   https://b24-cbqwqo.bitrix24site.ru/fpnz/   — 2 страницы,
//   https://b24-cbqwqo.bitrix24site.ru/doshi/  — 2 страницы.
// Все они ведут на портал заказчика и создают там живые лиды. Сегодня их переписывает
// `registrationHref`, то есть утечки нет; гейт же не увидел бы её и тогда, когда она
// появится, — а именно ради этого случая он и стоит.
//
// Отсюда предмет проверки: НАЗНАЧЕНИЕ ссылки (портал Bitrix24 либо заглушка), а не
// форма её пути.

const ROOT = join(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'scripts', 'lib', 'deploy-checks.sh');

const CUSTOMER = 'https://b24-cbqwqo.bitrix24site.ru';
const CUSTOMER_SECOND = 'https://b24-kbo5ls.bitrix24site.ru';
const OWN_TEST_PORTAL = 'b24-test123.bitrix24site.ru';

/** Каталог сборки из карты «относительный путь → список href на странице». */
function dist(pages: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-form-links-'));
  for (const [rel, hrefs] of Object.entries(pages)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    const body = hrefs.map((h) => `<a href="${h}">Записаться</a>`).join('\n');
    writeFileSync(file, `<!doctype html><html><body>\n${body}\n</body></html>\n`);
  }
  return dir;
}

/** Каталог сборки из готовой разметки — когда предмет проверки сам носитель ссылки. */
function distRaw(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-form-links-raw-'));
  for (const [rel, body] of Object.entries(pages)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `<!doctype html><html><body>\n${body}\n</body></html>\n`);
  }
  return dir;
}

type Run = { code: number; stdout: string; stderr: string };

async function gate(distDir: string, mode: string, demo = ''): Promise<Run> {
  const script =
    `set -uo pipefail; source '${LIB}'; ` +
    `form_links_match_mode '${distDir}' '${mode}' '${demo}'`;
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', script]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('form_links_match_mode — режим stand с заглушкой', () => {
  it('набор из одних заглушек проходит', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka'], 'oplata/index.html': ['/demo-zayavka'] });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, r.stderr).toBe(0);
  });

  it('ссылка на портал заказчика БЕЗ crm_form в пути останавливает выкладку', async () => {
    // Ровно случай подписки в футере: путь `/news/`, назначение — CRM заказчика.
    const d = dist({
      'index.html': ['/demo-zayavka', `${CUSTOMER}/news/`],
      'stati/index.html': ['/demo-zayavka'],
    });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, `гейт пропустил ${CUSTOMER}/news/ на стенде`).toBe(1);
    expect(r.stderr).toContain('/news/');
  });

  it('ссылка на портал заказчика с crm_form в пути тоже останавливает выкладку', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka', `${CUSTOMER}/crm_form_ve1op/`] });
    expect((await gate(d, 'stand', 'stub')).code).toBe(1);
  });

  it('второй портал заказчика ловится наравне с первым', async () => {
    // Порталов у заказчика два (b24-cbqwqo и b24-kbo5ls); признак не перечисляет их.
    const d = dist({ 'index.html': ['/demo-zayavka', `${CUSTOMER_SECOND}/crm_form_iciwb/`] });
    expect((await gate(d, 'stand', 'stub')).code).toBe(1);
  });

  it('protocol-relative ссылка на портал не проходит мимо признака', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka', '//b24-cbqwqo.bitrix24site.ru/news/'] });
    expect((await gate(d, 'stand', 'stub')).code).toBe(1);
  });

  it('адрес портала в query-параметре чужого домена признаком не является', async () => {
    // Признак сопоставляется с ХОСТОМ назначения, а не с подстрокой в любом месте URL:
    // иначе ложное срабатывание останавливало бы исправную выкладку.
    const d = dist({
      'index.html': ['/demo-zayavka', `https://example.org/go?to=b24-cbqwqo.bitrix24site.ru`],
    });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, r.stderr).toBe(0);
  });
});

describe('form_links_match_mode — режим stand со своим тестовым порталом', () => {
  it('набор на заказанном портале проходит независимо от формы пути', async () => {
    const d = dist({
      'index.html': [`https://${OWN_TEST_PORTAL}/news/`],
      'oplata/index.html': [`https://${OWN_TEST_PORTAL}/crm_form_ve1op/`],
    });
    const r = await gate(d, 'stand', OWN_TEST_PORTAL);
    expect(r.code, r.stderr).toBe(0);
  });

  it('утечка на портал заказчика рядом с правильными формами останавливает выкладку', async () => {
    // Сердцевина дефекта: правильная ссылка формы соседствует с ссылкой на CRM
    // заказчика, у которой другой путь. Прежний гейт отбирал только первую и был зелён.
    const d = dist({
      'oplata/index.html': [`https://${OWN_TEST_PORTAL}/crm_form_ve1op/`],
      'index.html': [`${CUSTOMER}/news/`],
    });
    const r = await gate(d, 'stand', OWN_TEST_PORTAL);
    expect(r.code, `утечка ${CUSTOMER}/news/ не остановила выкладку стенда`).toBe(1);
    expect(r.stderr).toContain('/news/');
  });

  it('заглушка при заказанном портале не считается соответствием', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka'] });
    expect((await gate(d, 'stand', OWN_TEST_PORTAL)).code).toBe(1);
  });
});

describe('form_links_match_mode — боевой режим', () => {
  it('ссылки на портал заказчика проходят при ЛЮБОЙ форме пути', async () => {
    // Страховка от переусердствования при исправлении: `/news/`, `/umac1/`, `/fpnz/`,
    // `/doshi/` — законные боевые адреса. Признак «путь начинается на crm_form_»
    // отверг бы исправную боевую сборку.
    const d = dist({
      'index.html': [`${CUSTOMER}/news/`],
      'raspisanie-i-tseny/index.html': [`${CUSTOMER}/crm_form_ve1op/`, `${CUSTOMER}/umac1/`],
      'seminary/index.html': [`${CUSTOMER_SECOND}/crm_form_iciwb/`],
    });
    const r = await gate(d, 'prod', '');
    expect(r.code, r.stderr).toBe(0);
  });

  it('заглушка в боевой сборке останавливает выкладку', async () => {
    const d = dist({
      'index.html': [`${CUSTOMER}/crm_form_ve1op/`],
      'oplata/index.html': ['/demo-zayavka'],
    });
    const r = await gate(d, 'prod', '');
    expect(r.code, 'боевая сборка с заглушкой прошла — обращения клиентов терялись бы').toBe(1);
    expect(r.stderr).toContain('/demo-zayavka');
  });

  it('заглушка НЕ в корне тоже останавливает боевую выкладку', async () => {
    // Находка ревью F5: отбор кандидатов не должен быть заякорен, иначе адрес,
    // содержащий `demo-zayavka` не в начале пути, перестаёт быть кандидатом и
    // проходит молча — а прежний гейт его останавливал. Заглушка в боевой сборке
    // теряет обращения клиентов независимо от того, в корне она или нет.
    const d = dist({
      'index.html': [`${CUSTOMER}/crm_form_ve1op/`, '/podacha/demo-zayavka'],
    });
    const r = await gate(d, 'prod', '');
    expect(r.code, 'заглушка не в корне прошла боевой гейт').toBe(1);
    expect(r.stderr).toContain('/podacha/demo-zayavka');
  });

  it('чужой домен с crm_form в пути не проходит', async () => {
    const d = dist({
      'index.html': [`${CUSTOMER}/crm_form_ve1op/`, 'https://example.org/crm_form_ve1op/'],
    });
    expect((await gate(d, 'prod', '')).code).toBe(1);
  });
});

describe('form_links_match_mode — ссылка ловится не только в href="…"', () => {
  // Находка ревью F6: переписыватель `redirectFormLinksInDemo` принимает
  // `href\s*=\s*("…"|'…')`, а гейт принимал только `href="…"`. Проверяющий, у которого
  // язык уже, чем у переписывателя, оставляет щель ровно между ними.
  const cases: [string, string][] = [
    ['одинарные кавычки', `<a href='${CUSTOMER}/news/'>x</a>`],
    ['пробелы вокруг =', `<a href = "${CUSTOMER}/news/">x</a>`],
    ['без кавычек', `<a href=${CUSTOMER}/umac1/>x</a>`],
    ['iframe src', `<iframe src="${CUSTOMER}/crm_form_ve1op/"></iframe>`],
    ['form action', `<form action="${CUSTOMER}/news/"></form>`],
    // Находки владельца на 3604de4. Имена атрибутов в HTML регистронезависимы, а
    // ведущий пробел в значении браузеру перейти по адресу не мешает — ссылка остаётся
    // кликабельной, а извлечение её не видело: имя атрибута сопоставлялось с учётом
    // регистра, значение не нормализовалось. Соседняя правильная заглушка при этом
    // делала гейт зелёным.
    ['имя атрибута в верхнем регистре', `<a HREF="${CUSTOMER}/news/">x</a>`],
    ['смешанный регистр имени', `<a HrEf="${CUSTOMER}/news/">x</a>`],
    ['ведущие пробелы в значении', `<a href="  ${CUSTOMER}/news/">x</a>`],
    ['верхний регистр + пробелы', `<a SRC="  ${CUSTOMER}/crm_form_ve1op/">x</a>`],
  ];

  for (const [what, markup] of cases) {
    it(`утечка через «${what}» останавливает выкладку стенда`, async () => {
      const d = distRaw({ 'index.html': `<a href="/demo-zayavka">s</a>\n${markup}` });
      const r = await gate(d, 'stand', 'stub');
      expect(r.code, `носитель «${what}» прошёл мимо признака`).toBe(1);
    });
  }
});

describe('form_links_match_mode — признак назначения не перечисляет частные случаи', () => {
  // Находка ревью F9: список доменов и чувствительность к регистру отстают от предмета
  // молча — это то же «перечисление частных случаев», что и прежний список путей.
  const leaks: [string, string][] = [
    ['апекс-домен без поддомена', 'https://bitrix24site.ru/x'],
    ['верхний регистр хоста', 'https://B24-CBQWQO.BITRIX24SITE.RU/news/'],
    ['портальный домен bitrix24.ru', 'https://b24-x.bitrix24.ru/pub/form/1_a/'],
  ];

  for (const [what, url] of leaks) {
    it(`${what} считается утечкой`, async () => {
      const d = dist({ 'index.html': ['/demo-zayavka', url] });
      expect((await gate(d, 'stand', 'stub')).code, `${url} прошёл мимо признака`).toBe(1);
    });
  }

  it('crm_form в query-параметре чужого домена НЕ является нарушением', async () => {
    // Находка ревью F3, зеркало предыдущих: голая подстрока `crm_form` давала ложный
    // ОТКАЗ и останавливала исправную выкладку. Признак смотрит на путь, не на query.
    const d = dist({ 'index.html': ['/demo-zayavka', 'https://example.org/go?src=crm_form'] });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, r.stderr).toBe(0);
  });
});

describe('form_links_match_mode — значение DEMO_FORMS проверяется до подстановки', () => {
  // Находка ревью F1, единственная дававшая ложное ЗЕЛЁНОЕ на живой утечке: значение
  // из окружения попадало в ERE как есть. Невалидная регулярка → grep код 2 → `|| true`
  // → «нарушений нет», и стенд выкладывался со ссылками в CRM заказчика.
  const bad: [string, string][] = [
    ['несбалансированная скобка', 'b24-x(.bitrix24site.ru'],
    ['регулярка «что угодно»', '.*'],
    ['завершающий слэш', 'b24-x.bitrix24site.ru/'],
    ['пустое значение', ''],
    ['схема вместо хоста', 'https://b24-x.bitrix24site.ru'],
  ];

  for (const [what, value] of bad) {
    it(`${what} — отказ, а не молчаливый пропуск утечки`, async () => {
      const d = dist({ 'index.html': [`${CUSTOMER}/news/`] });
      const r = await gate(d, 'stand', value);
      expect(r.code, `DEMO_FORMS='${value}' не остановил утечку`).toBe(1);
      expect(r.stderr).toContain('проверка форм не выполнена');
    });
  }

  it('нормальное имя хоста работает', async () => {
    const d = dist({ 'index.html': [`https://${OWN_TEST_PORTAL}/news/`] });
    const r = await gate(d, 'stand', OWN_TEST_PORTAL);
    expect(r.code, r.stderr).toBe(0);
  });
});

describe('form_links_match_mode — отличает «нарушений нет» от «проверить не удалось»', () => {
  it('сборка без единой ссылки на форму — отказ, а не успех', async () => {
    const d = dist({ 'index.html': ['/kontakty', '/statyi'] });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, 'вакуумный результат засчитан как успех').toBe(1);
    expect(r.stderr).toContain('проверять нечего');
  });

  it('несуществующий каталог — отказ, каким бы grep ни был', async () => {
    // Находка ревью F5 и МОЯ ошибка при её исправлении, поэтому обе записаны здесь.
    //
    // Ревью: прежняя редакция принимала любое из двух сообщений
    // (`не удалось прочитать|проверять нечего`) и потому не показывала, какая ветвь
    // исполнена. Верно: BSD grep на macOS отдаёт для отсутствующего каталога 1, GNU grep
    // на ubuntu — 2, то есть вход попадает в РАЗНЫЕ ветви функции.
    //
    // Моя ошибка: я закрепила одно сообщение — то, которое даёт macOS. В CI на ubuntu
    // тест немедленно упал. Закреплять тут нечего: расхождение реально, оно в самом
    // grep, и выбор любой из двух сторон делает проверку платформенной.
    //
    // Поэтому здесь утверждается только ИСХОД (отказ, а не молчаливый успех), а обе
    // ветви покрыты входами, которые ведут себя одинаково везде: `form_count == 0` —
    // проверкой «сборка без единой ссылки на форму», `grep код 2+` — проверкой с
    // `chmod 000` ниже. Разделение ветвей не потеряно, оно просто закреплено за
    // детерминированными входами.
    const r = await gate(join(tmpdir(), 'ikpk-form-links-нет-такого'), 'stand', 'stub');
    expect(r.code, 'несуществующий каталог засчитан как успех').toBe(1);
    expect(r.stdout, 'напечатано подтверждение по несуществующему каталогу').not.toContain(
      'все соответствуют',
    );
  });

  it('нечитаемый файл внутри каталога — отказ «проверка не выполнена»', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka'] });
    chmodSync(join(d, 'index.html'), 0o000);
    try {
      const r = await gate(d, 'stand', 'stub');
      expect(r.code, 'сбой чтения выдан за отсутствие нарушений').toBe(1);
      expect(r.stderr).toContain('проверка форм не выполнена');
    } finally {
      chmodSync(join(d, 'index.html'), 0o644);
    }
  });

  it('неизвестный режим — отказ, а не молчаливый пропуск', async () => {
    const d = dist({ 'index.html': ['/demo-zayavka'] });
    const r = await gate(d, 'preview', '');
    expect(r.code, 'неизвестный режим прошёл гейт').toBe(1);
    // Проверяется СООБЩЕНИЕ, а не только код выхода. Первая редакция ветки писала
    // `${mode@Q}` — синтаксис bash 4.4+, — и под системным bash 3.2 (macOS) падала
    // с `bad substitution`. Код выхода совпадал, поэтому проверка была зелёной, ни
    // разу не выполнив ветку по назначению.
    expect(r.stderr).toContain("неизвестный режим 'preview'");
    expect(r.stderr).not.toContain('bad substitution');
  });
});
