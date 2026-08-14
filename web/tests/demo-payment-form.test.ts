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
