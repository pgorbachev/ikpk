/**
 * Матрица контуров: АРТЕФАКТ объявляет роль, и по роли определяется предмет проверки
 * (задачи 5.10, 5.10a, 5.10d, 6.13; дельта `specs/deploy-gating/spec.md`).
 *
 * Предмет — вывод сборки в `web/dist`, прочитанный БЕЗ выполнения скриптов. Проверка
 * ветвится по объявленной роли, а не по числу форм: «ноль форм» и «нет активной формы» —
 * разные наблюдения (спека, Requirement «Установленные платёжные контуры нельзя
 * публиковать выключенными или перепутанными», определение «активной формы» из четырёх
 * условий).
 *
 * Источник требований (change `online-payment-flow`):
 *  - `specs/online-payment/spec.md`, Requirement «Роль сборки объявлена перечислением, а
 *    не признаком «демо»», сценарий «Роль сборки читается из разметки»: значение из
 *    набора `ci|preview|stand|prod`, признака `data-payment-demo` в артефакте нет;
 *  - там же, Requirement «Адрес платёжного эндпоинта опознаётся в сборке», сценарии
 *    «Адрес объявлен в разметке» и «Объявленный адрес соответствует режиму сборки»;
 *  - там же, сценарии «Артефакт без формы не обещает оплату на странице» и «CI может
 *    собрать страницу без оплаты»;
 *  - там же, Requirement «Публикуемое описание порядка оплаты соответствует поведению
 *    формы», сценарий «Формы нет — описание не обещает оплату на сайте»;
 *  - `specs/deploy-gating/spec.md`, сценарии «роль без формы проверяется на отсутствие
 *    формы», «роль с формой проверяется на её наличие», «роль не объявлена».
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРАВКА `payment-form-dist.test.ts`: тот написан под прежнюю
 * матрицу — требует РОВНО ОДНУ форму и буквально `https://api.ikpk.su` в любом артефакте,
 * а также безусловного отсутствия устаревшей подводки. Расхождение названо, а не скрыто:
 * привести те проверки к роли — предмет задачи 6.14, и до её выполнения два файла дают
 * разные ответы про один артефакт. Здесь ответ по спеке; там — по прежней матрице.
 *
 * ПОЧЕМУ КРАСНЫЕ СЕЙЧАС: на `12f2135` (продуктовый код с `ac4089b` не менялся: обе поставки — спека и тесты) артефакт роли не объявляет вовсе — в разметке стоит
 * булев `data-payment-demo` (`src/components/payment/PaymentForm.astro`), а `withPaymentCopy`
 * (`src/pages/oplata.astro`) переписывает описание на «оплатите на этой странице»
 * безусловно, независимо от наличия активной формы.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dist, readPage, walkHtml } from './helpers/dist-pages';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_ENDPOINT_BASE,
  PAYMENT_FORM_ATTR,
  PAYMENT_ROLES,
  PAYMENT_ROLE_ATTR,
  RETIRED_DEMO_ATTR,
  type PaymentRole,
} from './helpers/payment-contract';

const PAGE = '/oplata';

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

function declaredEndpoint(tag: string): string | undefined {
  return tag.match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1];
}

/**
 * Роль артефакта. Отсутствие роли — НЕПРОЙДЕННАЯ проверка, а не «предмета нет»:
 * потерянная роль иначе читалась бы как разрешение пропустить проверку.
 */
function artifactRole(html: string): PaymentRole {
  const values = [...html.matchAll(new RegExp(`\\b${PAYMENT_ROLE_ATTR}="([^"]*)"`, 'gi'))].map((m) => m[1]!);
  if (values.length === 0) {
    throw new Error(
      `артефакт не объявляет ${PAYMENT_ROLE_ATTR} на ${PAGE} — проверка не пройдена, ` +
        'а не «предмета нет» (spec deploy-gating, сценарий «роль не объявлена»)',
    );
  }
  const unique = [...new Set(values)];
  expect(unique, `в одном артефакте объявлено несколько ролей: ${unique.join(', ')}`).toHaveLength(1);
  const value = unique[0]!;
  expect(PAYMENT_ROLES as readonly string[], `роль вне набора: ${value}`).toContain(value);
  return value as PaymentRole;
}

/**
 * Активная форма: признак + объявленная база, буквально равная ожидаемой для роли, при роли
 * `stand` либо `prod`. У `ci` формы нет вовсе, у `preview` она есть, но ведёт на mock —
 * активной по определению спеки не является ни та, ни другая.
 */
function activeForms(html: string, role: PaymentRole): string[] {
  if (role === 'ci' || role === 'preview') return [];
  return paymentForms(html).filter((tag) => declaredEndpoint(tag) === PAYMENT_ENDPOINT_BASE[role]);
}

describe('5.10a артефакт объявляет роль перечислением; прежний булев признак удалён', () => {
  it('роль читается из разметки страницы оплаты и входит в набор ci|preview|stand|prod', () => {
    expect(PAYMENT_ROLES as readonly string[]).toContain(artifactRole(readPage(PAGE)));
  });

  it(`признака ${RETIRED_DEMO_ATTR} нет ни на одной странице артефакта`, () => {
    const hits: string[] = [];
    for (const file of walkHtml()) {
      if (readFileSync(file, 'utf8').includes(RETIRED_DEMO_ATTR)) hits.push(file.replace(dist, ''));
    }
    expect(hits, 'булев признак прежней матрицы остался в артефакте').toEqual([]);
  });

  it('все страницы артефакта объявляют одну и ту же роль', () => {
    const found = new Set<string>();
    for (const file of walkHtml()) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        new RegExp(`\\b${PAYMENT_ROLE_ATTR}="([^"]*)"`, 'gi'),
      )) {
        found.add(m[1]!);
      }
    }
    expect([...found]).toHaveLength(1);
  });
});

describe('5.10/6.13 объявленный адрес и число форм ожидаются ПО РОЛИ', () => {
  it('роль с формой: ровно одна форма с буквально ожидаемой для роли базой; ноль — отказ', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (role === 'ci') {
      expect(paymentForms(html), 'роль ci: формы быть не должно').toHaveLength(0);
      return;
    }
    const forms = paymentForms(html);
    expect(forms.length, `роль ${role}: формы нет — предмет проверки потерян`).toBe(1);
    const value = declaredEndpoint(forms[0]!);
    expect(value, `роль ${role}: форма без ${PAYMENT_ENDPOINT_ATTR}`).toBeTruthy();
    expect(value).toBe(PAYMENT_ENDPOINT_BASE[role]);
    expect(/hidden|inert|aria-hidden="true"/.test(forms[0]!)).toBe(true);
  });

  // Роль `ci`: ноль форм И ни одного объявленного эндпоинта. Второе — не придирка: дельта
  // `deploy-gating` называет наличие объявленного эндпоинта у роли без формы отказом, потому
  // что адрес без формы всё равно обещает контур, которого в артефакте нет.
  it('роль ci: ни платёжной формы, ни объявленного эндпоинта', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (role !== 'ci') return;
    expect(paymentForms(html)).toHaveLength(0);
    expect(html).not.toMatch(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}=`));
  });

  it('роль preview: ровно одна форма, и её база — буквально mock-адрес', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (role !== 'preview') return;
    const forms = paymentForms(html);
    expect(forms.length, 'роль preview обязана нести форму для клиентских сценариев').toBe(1);
    expect(declaredEndpoint(forms[0]!)).toBe(PAYMENT_ENDPOINT_BASE.preview);
  });

  it('никакая роль, кроме stand и prod, не объявляет базу установленного контура', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (role === 'stand' || role === 'prod') return;
    for (const value of paymentForms(html).map(declaredEndpoint)) {
      expect(value).not.toBe(PAYMENT_ENDPOINT_BASE.prod);
      expect(value).not.toBe(PAYMENT_ENDPOINT_BASE.stand);
    }
  });

  it('база не содержит пути запроса: клиент дописывает /payments сам', () => {
    const html = readPage(PAGE);
    for (const tag of paymentForms(html)) {
      const value = declaredEndpoint(tag) ?? '';
      expect(value.endsWith('/payments'), `база уже содержит путь: ${value}`).toBe(false);
    }
  });

  it('чужая база не встречается ни на одной странице артефакта', () => {
    const role = artifactRole(readPage(PAGE));
    const forbidden = (Object.keys(PAYMENT_ENDPOINT_BASE) as ('preview' | 'stand' | 'prod')[])
      .filter((r) => r !== role)
      .map((r) => PAYMENT_ENDPOINT_BASE[r]);
    const hits: string[] = [];
    for (const file of walkHtml()) {
      const text = readFileSync(file, 'utf8');
      for (const value of forbidden) {
        if (new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(text)) {
          hits.push(`${file.replace(dist, '')}: ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('5.10d описание пути оплаты едет вместе с формой', () => {
  const PROMISE = /(Оплатите семинар банковской картой на этой странице|заполните форму на этой странице)/i;
  const LEGACY_EXTERNAL = 'Подать заявку на интересующий вас курс через сайт';

  it('активной формы нет — страница не обещает оплату на ней и сохраняет уход на внешнюю форму', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (activeForms(html, role).length > 0) return;
    const text = html.replace(/\s+/g, ' ');
    expect(PROMISE.test(text), 'артефакт без активной формы обещает оплату на странице').toBe(false);
    expect(text.includes(LEGACY_EXTERNAL), 'прежнее описание с уходом на внешнюю форму не сохранено').toBe(true);
  });

  it('активная форма есть — описание называет оплату на странице и не сводит порядок к заявке', () => {
    const html = readPage(PAGE);
    const role = artifactRole(html);
    if (activeForms(html, role).length === 0) return;
    const text = html.replace(/\s+/g, ' ');
    expect(PROMISE.test(text)).toBe(true);
    expect(text.includes(LEGACY_EXTERNAL)).toBe(false);
  });
});
