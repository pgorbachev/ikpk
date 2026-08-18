import { describe, expect, it } from 'vitest';
import { readDemoPage } from './helpers/demo-dist';
import { PAYMENT_ENDPOINT_ATTR, PAYMENT_FORM_ATTR } from './helpers/payment-contract';

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

describe('3.9 клиент: демо-адрес формы', () => {
  it('объявленный адрес в демо-сборке — демонстрационный, не боевой', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'в демо-сборке нет формы оплаты').toBeGreaterThan(0);
    const endpoint = forms[0].match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1] ?? '';
    expect(endpoint).toBeTruthy();
    expect(endpoint).not.toMatch(/api\.ikpk\.su|yookassa|ykassa/i);
  });
});

describe('3.12c ветвь (3) демо-сборка с формой', () => {
  it('описание порядка оплаты то же, что у боевой с формой — не сводит к заявке со звонком', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'демо-формы нет').toBeGreaterThan(0);
    expect(html).not.toMatch(/Подать заявку на интересующий вас курс через сайт/i);
    expect(html).toMatch(/оплат/i);
  });
});

// ─── 6.3: признаки демо-сборки сверяются БУКВАЛЬНО ───────────────────────────
//
// Проверка выше требует лишь «адрес не боевой» — под это подходит и опечатка, и чужой
// хост, и пустая строка. У боевой сборки буквальное равенство уже стережётся
// (`payment-form-dist.test.ts`, 3.12), у демонстрационной такой сверки не было, хотя
// гейт деплоя (`payment_endpoint_matches`) требует равенства в обоих режимах. Без неё
// сборка могла разойтись с тем, что проверяет деплой, и расхождение всплыло бы только
// при выкладке.
describe('6.3 демо-сборка: адрес и признак режима равны ожидаемым', () => {
  it('data-payment-endpoint равен демонстрационному адресу буквально', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'в демо-сборке нет формы оплаты').toBeGreaterThan(0);
    const endpoint = forms[0].match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1] ?? '';
    const expected = process.env.PAYMENT_ENDPOINT_DEMO ?? 'https://demo-api.ikpk.invalid';
    expect(endpoint).toBe(expected);
  });

  it('data-payment-demo равен true: клиент знает, что он демонстрационный', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length).toBeGreaterThan(0);
    const flag = forms[0].match(/\bdata-payment-demo="([^"]*)"/)?.[1] ?? '';
    expect(flag).toBe('true');
  });
});
