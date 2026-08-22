import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
// Ссылки с другим путём — не гипотеза. В прод-сборке на 2026-08-22 из 35 различных
// адресов Bitrix24 четыре не содержат `crm_form`:
//   https://b24-cbqwqo.bitrix24site.ru/news/   — 267 страниц (подписка в футере),
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

  it('чужой домен с crm_form в пути не проходит', async () => {
    const d = dist({
      'index.html': [`${CUSTOMER}/crm_form_ve1op/`, 'https://example.org/crm_form_ve1op/'],
    });
    expect((await gate(d, 'prod', '')).code).toBe(1);
  });
});

describe('form_links_match_mode — отличает «нарушений нет» от «проверить не удалось»', () => {
  it('сборка без единой ссылки на форму — отказ, а не успех', async () => {
    const d = dist({ 'index.html': ['/kontakty', '/statyi'] });
    const r = await gate(d, 'stand', 'stub');
    expect(r.code, 'вакуумный результат засчитан как успех').toBe(1);
    expect(r.stderr).toContain('проверять нечего');
  });

  it('нечитаемый каталог сборки — отказ с объяснением', async () => {
    const r = await gate(join(tmpdir(), 'ikpk-form-links-нет-такого'), 'stand', 'stub');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/не удалось прочитать|проверять нечего/);
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
