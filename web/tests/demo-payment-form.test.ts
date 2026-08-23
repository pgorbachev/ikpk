/**
 * Проверки артефакта, на котором идут клиентские сценарии. РОЛЬ этого артефакта — `preview`
 * (`dist-demo`), и это предмет задачи 6.14: привести уже слитые проверки к матрице ролей.
 *
 * ЧТО ИМЕННО ИЗМЕНИЛОСЬ. Прежняя редакция требовала `data-payment-demo="true"` — булев
 * признак «демо» прежней матрицы. Решением владельца от 2026-08-18 он удалён, а решением от
 * 2026-08-19 артефакт с mock-формой получил роль `preview`: ожидание гейта выводится ИЗ РОЛИ,
 * а второй уточняющий признак рядом с ролью спека прямо запрещает. Требовать здесь удалённый
 * атрибут значило бы держать гейт, который краснеет от выполненной работы, и одновременно
 * давать про один артефакт два разных ответа с `preview-role-dist.test.ts`.
 *
 * РАЗГРАНИЧЕНИЕ С `preview-role-dist.test.ts`, чтобы у двух файлов не оказался один предмет:
 * там — артефакт ЦЕЛИКОМ (роль на всех страницах, отсутствие прежнего признака на всех
 * страницах, база установленного контура не встречается нигде). Здесь — страница `/oplata` и
 * её ФОРМА: адрес объявлен буквально, роль страницы с формой объявлена, описание порядка
 * оплаты соответствует наличию формы. Оба файла отвечают ОДИНАКОВО там, где предметы
 * пересекаются (роль `preview`, отсутствие `data-payment-demo`) — расхождения между ними нет,
 * и это проверяется тем, что оба идут в одном прогоне `vitest.demo.config.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readDemoPage } from './helpers/demo-dist';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_ROLE_ATTR,
  PREVIEW_MOCK_ENDPOINT,
  RETIRED_DEMO_ATTR,
} from './helpers/payment-contract';

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

describe('3.9 клиент: mock-адрес формы артефакта роли preview', () => {
  it('объявленный адрес — mock, не боевой', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'в артефакте роли preview нет формы оплаты').toBeGreaterThan(0);
    const endpoint = forms[0].match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1] ?? '';
    expect(endpoint).toBeTruthy();
    expect(endpoint).not.toMatch(/api\.ikpk\.su|yookassa|ykassa/i);
  });
});

describe('3.12c ветвь (3) артефакт роли preview с формой', () => {
  it('описание порядка оплаты то же, что у боевой с формой — не сводит к заявке со звонком', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'формы роли preview нет').toBeGreaterThan(0);
    expect(html).not.toMatch(/Подать заявку на интересующий вас курс через сайт/i);
    expect(html).toMatch(/оплат/i);
  });
});

// ─── 6.3/6.14: признаки артефакта роли `preview` сверяются БУКВАЛЬНО ─────────
//
// Проверка выше требует лишь «адрес не боевой» — под это подходит и опечатка, и чужой
// хост, и пустая строка. У боевой сборки буквальное равенство уже стережётся
// (`payment-form-dist.test.ts`, 3.12), у этой сборки такой сверки не было, хотя
// гейт деплоя (`payment_endpoint_matches`) требует равенства в обоих режимах. Без неё
// сборка могла разойтись с тем, что проверяет деплой, и расхождение всплыло бы только
// при выкладке.
describe('6.3/6.14 артефакт роли preview: адрес и объявленная роль равны ожидаемым', () => {
  it('data-payment-endpoint равен mock-адресу буквально', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'в артефакте роли preview нет формы оплаты').toBeGreaterThan(0);
    const endpoint = forms[0].match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1] ?? '';
    // Значение по умолчанию берётся из контракта, а не из литерала в тесте: та же константа
    // описывает базу роли `preview` во всех проверках. Переопределение сборки
    // (`PAYMENT_ENDPOINT_DEMO`) продукт поддерживает — тогда ожидание переопределяется тем же
    // значением, иначе тест краснел бы от законной настройки.
    const expected = process.env.PAYMENT_ENDPOINT_DEMO ?? PREVIEW_MOCK_ENDPOINT;
    expect(endpoint).toBe(expected);
  });

  it('страница с формой объявляет роль preview, а не булев признак прежней матрицы', () => {
    const html = readDemoPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'в артефакте роли preview нет формы оплаты').toBeGreaterThan(0);
    // «Роль не объявлена» — НЕПРОЙДЕННАЯ проверка, а не «нарушений нет»: без роли неизвестно,
    // какой артефакт читают клиентские сценарии, и любой их зелёный исход ничего не значит.
    const roles = [
      ...new Set(
        [...html.matchAll(new RegExp(`\\b${PAYMENT_ROLE_ATTR}="([^"]*)"`, 'gi'))].map((m) => m[1]!),
      ),
    ];
    expect(roles, `страница /oplata не объявляет ${PAYMENT_ROLE_ATTR} — проверка не пройдена`).not.toEqual([]);
    expect(roles).toEqual(['preview']);
  });

  it(`булева признака ${RETIRED_DEMO_ATTR} на странице с формой нет`, () => {
    const html = readDemoPage('/oplata');
    expect(paymentForms(html).length, 'в артефакте роли preview нет формы оплаты').toBeGreaterThan(0);
    expect(html.includes(RETIRED_DEMO_ATTR), 'признак прежней матрицы остался на странице').toBe(false);
  });
});
