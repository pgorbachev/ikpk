import { test, expect } from '@playwright/test';
import { TEMPLATES } from './helpers/templates';
import { installThirdPartyGuard } from './helpers/third-party-guard';

// Перехват сторонних запросов обязателен в КАЖДОМ браузерном прогоне — требование спеки
// change `external-widgets`, и его стережёт `tests/external-widgets-guard.test.ts`. Здесь он
// нужен и по сути, а не только по правилу: гейт открывает главную, где живут виджет отзывов
// и знак награды, и без перехвата прогон ходил бы к Яндексу за настоящими ответами.
// На предмет проверки перехват не влияет: измеряется НАША геометрия заголовков.
test.beforeEach(async ({ page }) => {
  await installThirdPartyGuard(page);
});

/**
 * Единое выравнивание заголовков секций — решение владельца 2026-09-05: «заголовки все
 * должны быть или отцентрированы, или слева», выбран центр.
 *
 * Гейт браузерный, и иначе нельзя: предмет — ВЫЧИСЛЕННОЕ выравнивание и фактическая
 * геометрия, а сборка зелена и на разъехавшихся заголовках. Правило `text-align: center`
 * в `utilities.css` само по себе ничего не гарантирует: три секции несут заголовок внутри
 * своей флекс-шапки со ссылкой справа, и там он центрируется внутри своей доли строки, а
 * не по секции. Замерено до правки: «Программы обучения» на странице института —
 * центр 269 против центра родителя 720 при `text-align: center`.
 *
 * Поэтому проверяются ДВА разных утверждения, и второе не выводится из первого:
 * вычисленное значение равно `center`, и центр заголовка совпадает с центром его
 * контейнера. Первое ловит потерю правила, второе — потерю ширины.
 *
 * Непустота предмета доказывается отдельно: на части шаблонов `.section-title` нет вовсе
 * (расписание, статьи, оплата — там заголовки другого рода), и «все заголовки выровнены»
 * на пустом множестве верно тривиально. Поэтому итог проверяется по СУММЕ найденных.
 */
test.describe('заголовки секций выровнены одинаково', () => {
  test.describe.configure({ timeout: 60_000 });

  const seen: Record<string, number> = {};

  for (const { name, path } of TEMPLATES) {
    test(`шаблон ${name}: каждый заголовок секции по центру`, async ({ page }) => {
      const response = await page.goto(path);
      // Черновики вариантов собираются только в демо-режиме — в боевой сборке их нет, и
      // это «проверять нечего», а не отказ. Идиома взята у `a11y.spec.ts:31`,
      // `if (name.startsWith('preview-') && response?.status() === 404) {`, чтобы два гейта
      // над одним перечнем шаблонов не расходились в трактовке одного и того же 404.
      if (name.startsWith('preview-') && response?.status() === 404) {
        test.skip(true, 'черновик варианта отсутствует в боевой сборке');
      }
      expect(response?.status(), `${path} не отдалась — проверять нечего`).toBe(200);

      const titles = await page.evaluate(() =>
        [...document.querySelectorAll('.section-title')].map((h) => {
          const box = h.getBoundingClientRect();
          const parent = h.parentElement!.getBoundingClientRect();
          return {
            text: (h.textContent ?? '').trim().slice(0, 40),
            align: getComputedStyle(h).textAlign,
            offset: Math.round(box.x + box.width / 2) - Math.round(parent.x + parent.width / 2),
          };
        }),
      );

      seen[name] = titles.length;

      for (const t of titles) {
        expect(t.align, `«${t.text}»: выравнивание ${t.align}, а не center`).toBe('center');
        expect(
          Math.abs(t.offset),
          `«${t.text}»: центр заголовка смещён на ${t.offset} px относительно центра его ` +
            'контейнера — правило есть, а ширины нет (заголовок внутри флекс-шапки)',
        ).toBeLessThanOrEqual(1);
      }
    });
  }

  test.afterAll(() => {
    const total = Object.values(seen).reduce((a, b) => a + b, 0);
    expect(
      total,
      'ни одного заголовка секции не найдено ни на одном шаблоне: утверждение «все ' +
        'выровнены по центру» было бы тривиально верным на пустом множестве',
    ).toBeGreaterThan(0);
  });
});
