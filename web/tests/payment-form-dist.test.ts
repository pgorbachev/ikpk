import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, readPage, walkHtml } from './helpers/dist-pages';
import {
  PAYMENT_ENDPOINT_ATTR,
  PAYMENT_FORM_ATTR,
  PAYMENT_ROLE_ATTR,
  TEST_HMAC_CURRENT,
  TEST_HMAC_PREVIOUS,
  TEST_YOOKASSA_SECRET,
  repoRoot,
} from './helpers/payment-contract';

// ── Приведено к матрице ролей задачей 6.14 ───────────────────────────────────
//
// Этот файл написан под ПРЕЖНУЮ матрицу, когда форма присутствовала в сборке
// безусловно: он требовал ровно одну форму на `/oplata` в любом артефакте. После
// задачи 5.10 у роли `ci` (обычная сборка без `PAYMENT_ROLE`, в т.ч. `npm run build`,
// которым собирается `dist` для этого же прогона) формы нет по контракту роли — «ноль
// форм» и «нет активной формы» разные наблюдения (дельта `deploy-gating`,
// `payment-role-dist.test.ts` уже проверяет это по роли). Предмет этого файла — то, что
// не переехало туда: подписи текста, отсутствие секретов, отсутствие несвязанных с
// формой утечек, — и то, что имеет смысл только при наличии формы, ветвится по роли.
//
// «Роль не объявлена» — НЕПРОЙДЕННАЯ проверка, а не «предмета нет» (независимое ревью,
// находка F-1, 2026-08-20): первая редакция этой правки возвращала `null` и молча
// пропускала («return») тесты при потерянной роли — то есть ровно тот дефект, который
// дельта `deploy-gating` называет прямо. `artifactRole` теперь бросает, если роль не
// объявлена или неоднозначна (как в `payment-role-dist.test.ts`), и это читается ДО
// какого-либо ветвления по роли — ветвление по роли остаётся только для случаев, где
// роль ЕСТЬ, но не та, к которой относится конкретная проверка.
//
// Ветвление на «роль без формы = не мой предмет» — того же ЛЕГИТИМНОГО рода, что и в
// `payment-role-dist.test.ts`/`preview-role-dist.test.ts`, но означает, что при роли `ci`
// (умалчиваемый `npm run build`, единственная роль в обязательном прогоне) часть тестов
// этого файла неисполнима НИКОГДА в этом прогоне — их предмет целиком в `payment-role-dist
// .test.ts`. Отмечено `it.skipIf`, а не бессловесным `return`: отчёт показывает «skip», а
// не «pass» там, где предмета для роли `ci` нет (AGENTS.md: «либо падать, либо говорить о
// вакуумности вслух»).
function artifactRole(html: string): string {
  const values = [...new Set([...html.matchAll(new RegExp(`\\b${PAYMENT_ROLE_ATTR}="([^"]*)"`, 'gi'))].map((m) => m[1]!))];
  if (values.length !== 1) {
    throw new Error(
      `артефакт не объявляет ровно одну роль ${PAYMENT_ROLE_ATTR} на /oplata (найдено: ${values.length}) — ` +
        'проверка не пройдена, а не «предмета нет»',
    );
  }
  return values[0]!;
}

function paymentForms(html: string): string[] {
  const re = new RegExp(`<form\\b[^>]*\\b${PAYMENT_FORM_ATTR}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[0]);
}

const role = artifactRole(readPage('/oplata'));
const hasActiveRole = role === 'stand' || role === 'prod';

describe('3.8 / 3.8a подписи и устаревшая подводка', () => {
  it.skipIf(!hasActiveRole)('3.8 подписи формы говорят про оплату, а не про заявку', () => {
    const html = readPage('/oplata');
    const forms = paymentForms(html);
    expect(forms.length, 'формы оплаты нет в сборке').toBeGreaterThan(0);
    expect(html).toMatch(/оплат/i);
    expect(html).not.toMatch(/записывайтесь к нам на обучение/i);
  });

  it.skipIf(!hasActiveRole)('3.8a устаревшая подводка отсутствует', () => {
    const html = readPage('/oplata');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(
      text.includes('выбирайте направление и записывайтесь к нам на обучение'),
      'устаревшая подводка всё ещё в сборке',
    ).toBe(false);
  });
});

describe('3.11 секреты не в dist', () => {
  it('ни секрет ЮKassa, ни ключи HMAC не встречаются в собранном сайте', () => {
    // Не привязано к наличию формы: секретов в статическом артефакте не бывает независимо
    // от роли, и проверка этого не должна отключаться потерей предмета в другом месте.
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
    // Хранилище сервера в dist быть не должно ни при какой роли. Если в сборке всплыли
    // JSON-записи — это дефект.
    const leaked = [...walkHtml()].filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /"keyVersion"\s*:/.test(t) || /"fingerprint"\s*:/.test(t);
    });
    expect(leaked.map((f) => f.replace(dist, ''))).toEqual([]);
  });
});

describe('3.12 форма в сборке скрыта, со своим признаком и адресом', () => {
  // Предмет — буквальный боевой адрес: применим только к роли prod. Роль ci (умалчиваемая
  // `npm run build`) формы не несёт по контракту роли — предмет переехал в
  // `payment-role-dist.test.ts`, а не потерялся.
  it.skipIf(role !== 'prod')('форма есть, скрыта, признак не href, адрес — буквальное равенство боевому контуру', () => {
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
  // У ci формы нет, у preview — не этот предмет (mock, не боевая семантика).
  it.skipIf(!hasActiveRole)('форма скрыта, со своим признаком и адресом; признак не на ArticleFilterBar и LeadMagnet', () => {
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
  // Ветвление по РОЛИ, а не по числу форм (независимое ревью, находка F-2): предикат
  // проверки не должен зависеть от того же предмета, который проверка исследует —
  // иначе дефект, обнуливший форму НЕ по контракту роли, читался бы как «ветвь (1)».
  it.skipIf(hasActiveRole)('ветвь (1) формы нет → описание не обещает оплату на сайте', () => {
    const html = readPage('/oplata');
    const page = html.replace(/\s+/g, ' ');
    const how = page.match(/Как оплатить\?[\s\S]{0,1200}/i)?.[0] ?? page;
    expect(how).not.toMatch(/оплат\w* на сайте|банковской картой через/i);
  });

  it.skipIf(!hasActiveRole)('ветвь (2) боевая сборка с формой → описание называет оплату на сайте, не сводит к заявке со звонком', () => {
    const html = readPage('/oplata');
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
