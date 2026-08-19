import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, readPage, walkHtml } from './helpers/dist-pages';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_FORM_ATTR,
  TEST_HMAC_CURRENT,
  TEST_HMAC_PREVIOUS,
  TEST_YOOKASSA_SECRET,
  repoRoot,
} from './helpers/payment-contract';

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

describe('3.8 / 3.8a подписи и устаревшая подводка', () => {
  it('3.8 подписи формы говорят про оплату, а не про заявку', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'формы оплаты нет в сборке').toBeGreaterThan(0);
    expect(html).toMatch(/оплат/i);
    expect(html).not.toMatch(/записывайтесь к нам на обучение/i);
  });

  it('3.8a устаревшая подводка отсутствует', () => {
    const html = readPage('/oplata').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(
      html.includes('выбирайте направление и записывайтесь к нам на обучение'),
      'устаревшая подводка всё ещё в сборке',
    ).toBe(false);
  });
});

describe('3.11 секреты не в dist', () => {
  it('ни секрет ЮKassa, ни ключи HMAC не встречаются в собранном сайте', () => {
    const html = readPage('/oplata');
    expect(paymentForms(html).length, 'формы нет — гейт секретов нечего проверять').toBeGreaterThan(0);
    const needles = [TEST_YOOKASSA_SECRET, TEST_HMAC_CURRENT, TEST_HMAC_PREVIOUS];
    const hits: string[] = [];
    for (const file of walkHtml()) {
      const text = readFileSync(file, 'utf8');
      for (const n of needles) {
        if (text.includes(n)) hits.push(`${file.replace(dist, '')}: ${n.slice(0, 12)}…`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('keyVersion в записях не является хешем/префиксом ключа; canary не стоит ни в записях, ни как keyVersion', () => {
    const html = readPage('/oplata');
    expect(paymentForms(html).length, 'формы нет — структурная проверка canary без предмета').toBeGreaterThan(0);
    // Хранилище сервера в dist быть не должно. Если в сборке всплыли JSON-записи — это дефект.
    const leaked = [...walkHtml()].filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /"keyVersion"\s*:/.test(t) || /"fingerprint"\s*:/.test(t);
    });
    expect(leaked.map((f) => f.replace(dist, ''))).toEqual([]);
  });
});

describe('3.12 форма в сборке скрыта, со своим признаком и адресом', () => {
  it('форма есть, скрыта, признак не href, адрес — буквальное равенство боевому контуру', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length).toBe(1);
    const tag = forms[0];
    expect(tag).toMatch(new RegExp(`\\b${PAYMENT_FORM_ATTR}\\b`));
    const endpoint = tag.match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1];
    expect(endpoint, 'нет data-payment-endpoint').toBeTruthy();
    expect(endpoint).not.toMatch(/yookassa|ykassa/i);
    expect(/hidden|aria-hidden="true"|inert/.test(tag) || html.includes('hidden')).toBe(true);
    const expected = process.env.PAYMENT_ENDPOINT_PROD ?? 'https://api.ikpk.su';
    expect(endpoint).toBe(expected);
  });
});

describe('3a.2 форма в собранной странице до скриптов', () => {
  it('форма скрыта, со своим признаком и адресом; признак не на ArticleFilterBar и LeadMagnet', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length).toBe(1);
    expect(forms[0]).toMatch(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}=`));
    const site = [...walkHtml()].map((f) => readFileSync(f, 'utf8')).join('\n');
    const tagged = [...site.matchAll(new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi'))];
    for (const tag of tagged) {
      expect(tag[0]).toMatch(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}=`));
      expect(tag[0]).not.toMatch(/article-filter|lead-form/i);
    }
  });
});

describe('3.12c описание порядка оплаты соответствует форме', () => {
  it('ветвь (1) формы нет → описание не обещает оплату на сайте', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    if (forms.length > 0) return; // ветви (2)/(3) — после появления формы
    const page = html.replace(/\s+/g, ' ');
    const how = page.match(/Как оплатить\?[\s\S]{0,1200}/i)?.[0] ?? page;
    expect(how).not.toMatch(/оплат\w* на сайте|банковской картой через/i);
  });

  it('ветвь (2) боевая сборка с формой → описание называет оплату на сайте, не сводит к заявке со звонком', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'формы нет — ветвь (2) красная до реализации').toBeGreaterThan(0);
    const page = html.replace(/\s+/g, ' ');
    expect(page).toMatch(/оплат/i);
    expect(page).not.toMatch(/Подать заявку на интересующий вас курс через сайт/i);
  });
});

describe('B2 / 4.9 гейт публикации видит оплату', () => {
  /**
   * ПРЕДМЕТ СУЖЕН ДВАЖДЫ, и оба раза часть его переехала, а не исчезла.
   *
   * Задачей 6.15: прежняя редакция требовала, чтобы `test:e2e:payment` упоминал
   * `payment-form.spec.ts`, а `test:e2e:payment-demo` — `playwright.demo.config.ts`. Оба
   * требования кодировали прежнюю организацию проверок: браузерные наборы разведены по РОЛИ
   * АРТЕФАКТА, клиентские сценарии идут на артефактах ролей `preview` и `stand`, а сам
   * `test:e2e:payment-demo` переименован.
   *
   * Решением владельца 2026-08-19: транспорт и инвариант контура тоже переехали на артефакт
   * роли `stand`, а скрипта `test:e2e:payment` больше нет. Требование «скрипт упоминает эти
   * два файла» было бы теперь красным от выполненной работы — и, что важнее, оно и раньше
   * ничего не доказывало: имя файла в командной строке не говорит, возьмёт ли его
   * конфигурация набора.
   *
   * Куда переехало, поимённо:
   *  - `tests/payment-artifact-roles.test.ts` — для КАЖДОЙ роли: обязательный прогон
   *    запускает её набор своей конфигурацией, конфигурация выбирает ровно объявленные файлы
   *    (спрошено у самого Playwright), артефакт роли готов до прогона;
   *  - `tests/browser-test-gating.test.ts` — ни один файл `*.spec.ts` не остался вне
   *    гейтующего workflow, и состав набора берётся из ФАКТИЧЕСКОГО перечня Playwright.
   * Оба строго сильнее упоминания имени в скрипте, поэтому дублировать их здесь нельзя: два
   * гейта об одном предмете дают два ответа.
   *
   * Здесь остаётся то, чего у наследников нет вовсе: охват пакета `payments` сканированием
   * безопасности.
   */
  it('пакет payments входит в сканирование безопасности', () => {
    const security = readFileSync(join(repoRoot, '.github/workflows/security.yml'), 'utf8');
    expect(security).toMatch(/^\s+- payments\s*$/m);
  });
});
