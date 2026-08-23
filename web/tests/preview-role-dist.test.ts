/**
 * Матрица контуров: АРТЕФАКТ РОЛИ `preview` (задачи 5.10, 5.10a, 6.14).
 *
 * Предмет — вывод `dist-demo`, то есть та самая сборка, на которой идут клиентские сценарии.
 * Решением владельца от 2026-08-19 (находка D1) она получила отдельную роль `preview`: прежде
 * тот же `ci` означал ещё и сборку без формы, и ожидание гейта из роли не выводилось.
 *
 * Источник требований (change `online-payment-flow`, `specs/online-payment/spec.md`):
 *  - Requirement «Роль сборки объявлена перечислением, а не признаком «демо»»: таблица ролей,
 *    у `preview` — форма, ведущая только на mock, и mock-адрес; сценарий «Роль определяет
 *    ожидаемый артефакт целиком»;
 *  - Requirement «Роли `ci` и `preview` не создают платежей…»: «Клиентские сценарии, которым
 *    форма нужна, SHALL исполняться на артефакте роли `preview`, а не `ci`»;
 *  - Requirement «Адрес платёжного эндпоинта опознаётся в сборке», сценарий «Объявленный адрес
 *    соответствует режиму сборки»: у `preview` — mock-адрес.
 *
 * РАСХОЖДЕНИЕ НАЗВАНО: `demo-payment-form.test.ts` проверяет тот же артефакт по прежней
 * матрице — требует `data-payment-demo="true"`. Привести его к роли — предмет задачи 6.14; до
 * этого два файла дают разные ответы про один артефакт, и здесь ответ по спеке.
 *
 * ПОВЕДЕНИЕ, а не только разметка: отсутствие удержания у этой сборки уже стережёт
 * `payment-form-demo.spec.ts` (3.10a-2b). Здесь только предмет разметки — чтобы у двух
 * проверок не оказался один предмет с риском разных ответов.
 */

import { describe, expect, it } from 'vitest';
import { readDemoPage, demoPages, demoDist, demoPagePath } from './helpers/demo-dist';
import { readFileSync } from 'node:fs';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_ENDPOINT_BASE,
  PAYMENT_FORM_ATTR,
  PAYMENT_ROLE_ATTR,
  RETIRED_DEMO_ATTR,
} from './helpers/payment-contract';

const PAGE = '/oplata';

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

function declaredRoles(html: string): string[] {
  return [...html.matchAll(new RegExp(`\\b${PAYMENT_ROLE_ATTR}="([^"]*)"`, 'gi'))].map((m) => m[1]!);
}

describe('5.10a артефакт клиентских сценариев объявляет роль preview', () => {
  it('роль объявлена и равна preview', () => {
    const roles = [...new Set(declaredRoles(readDemoPage(PAGE)))];
    expect(roles, 'артефакт dist-demo не объявляет роли — проверка не пройдена').not.toEqual([]);
    expect(roles).toEqual(['preview']);
  });

  it(`признака ${RETIRED_DEMO_ATTR} нет ни на одной странице артефакта`, () => {
    const hits = demoPages()
      .filter((f) => readFileSync(f, 'utf8').includes(RETIRED_DEMO_ATTR))
      .map((f) => demoPagePath(f, demoDist));
    expect(hits, 'булев признак прежней матрицы остался в артефакте').toEqual([]);
  });
});

describe('5.10 у роли preview форма есть и ведёт только на mock', () => {
  it('ровно одна форма, база буквально равна mock-адресу', () => {
    const html = readDemoPage(PAGE);
    const forms = paymentForms(html);
    expect(forms.length, 'роль preview обязана нести форму: на ней идут клиентские сценарии').toBe(1);
    const base = forms[0]!.match(new RegExp(`\\b${PAYMENT_ENDPOINT_ATTR}="([^"]*)"`))?.[1];
    expect(base).toBe(PAYMENT_ENDPOINT_BASE.preview);
  });

  it('база установленного контура не встречается ни на одной странице', () => {
    const hits: string[] = [];
    for (const file of demoPages()) {
      const text = readFileSync(file, 'utf8');
      for (const value of [PAYMENT_ENDPOINT_BASE.stand, PAYMENT_ENDPOINT_BASE.prod]) {
        if (text.includes(`${PAYMENT_ENDPOINT_ATTR}="${value}"`)) {
          hits.push(`${demoPagePath(file, demoDist)}: ${value}`);
        }
      }
    }
    expect(hits, 'preview объявляет адрес установленного контура').toEqual([]);
  });
});
