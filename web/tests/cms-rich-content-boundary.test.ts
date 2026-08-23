/**
 * КРАСНЫЕ тесты по дельте `rich-content-safety` change
 * `cms-content-authoring-and-migration`: черновик с непроходящей разметкой сохраняется
 * С ПРЕДУПРЕЖДЕНИЕМ, а отклоняется публикация.
 *
 * Дельта не меняет саму границу — политика, единый конвейер и центральный sink уже
 * приняты. Она добавляет то, чего в границе нет: СПОСОБ НАЗВАТЬ вырезанное. Сегодня его
 * нет по построению: `terminalSanitize` возвращает строку и о вырезанном молчит, поэтому
 * предупредить редактора нечем.
 *
 * Поэтому предмет здесь — функция отчёта о непринятой разметке (шов выбран сессией
 * тестов: `describeRejectedMarkup` рядом с самой границей, а не второй санитайзер).
 */

import { describe, expect, it } from 'vitest';
import { cleanBodyHtml } from '../src/lib/html-cleaner.js';
import { htmlOf } from './helpers/rich-content-safety/html-of.js';
import { loadRichContentFeedback } from './helpers/cms-authoring-contract';

const rendered = (html: string): string => htmlOf(cleanBodyHtml(html));

describe('дельта rich-content-safety: непринятая разметка называется', () => {
  // Scenario: черновик с непроходящей разметкой сохраняется с предупреждением
  // (часть, проверяемая чисто: непринятый АТРИБУТ назван)
  it('снятый атрибут назван в отчёте', async () => {
    const { describeRejectedMarkup } = await loadRichContentFeedback();
    const report = describeRejectedMarkup('<p onclick="alert(1)">текст</p>');
    expect(report.attributes, 'снятый атрибут не назван — предупредить редактора нечем').toContain(
      'onclick',
    );
  });

  it('снятый элемент назван в отчёте', async () => {
    const { describeRejectedMarkup } = await loadRichContentFeedback();
    const report = describeRejectedMarkup('<p><marquee>текст</marquee></p>');
    expect(report.elements, 'снятый элемент не назван').toContain('marquee');
  });

  it('разметка, проходящая границу, отчёта не порождает', async () => {
    const { describeRejectedMarkup } = await loadRichContentFeedback();
    const report = describeRejectedMarkup('<p>обычный <strong>текст</strong></p>');
    expect(report.elements).toEqual([]);
    expect(report.attributes).toEqual([]);
  });

  // Scenario: содержимое не теряется без предупреждения.
  // Инвариант проверяемый: всё, что граница вырезает, обязано попасть в отчёт. Без него
  // «редактор был предупреждён» неотличимо от «редактор не был предупреждён».
  it.each([
    ['<p onclick="alert(1)">текст</p>', { attributes: ['onclick'] }],
    ['<p style="color:red">текст</p>', { attributes: ['style'] }],
    ['<p><marquee>текст</marquee></p>', { elements: ['marquee'] }],
    ['<p><blink>текст</blink></p>', { elements: ['blink'] }],
  ])('вырезанное границей названо в отчёте: %s', async (input, expected) => {
    const { describeRejectedMarkup } = await loadRichContentFeedback();
    const output = rendered(input);
    const report = describeRejectedMarkup(input);

    for (const element of (expected as { elements?: string[] }).elements ?? []) {
      expect(output, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: граница пропустила <${element}>`).not.toContain(
        `<${element}`,
      );
      expect(report.elements, `<${element}> вырезан молча`).toContain(element);
    }
    for (const attribute of (expected as { attributes?: string[] }).attributes ?? []) {
      expect(output, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: граница пропустила ${attribute}`).not.toContain(
        `${attribute}=`,
      );
      expect(report.attributes, `${attribute} снят молча`).toContain(attribute);
    }
  });

  // Отчёт — НЕ вторая политика: он обязан называть ровно то, что вырезает единая
  // граница. Проверка на разметке, которую граница пропускает: отчёт молчит там, где
  // молчит граница, иначе у «допустимого» появилось бы два разных ответа.
  it('отчёт не запрещает того, что граница пропускает', async () => {
    const { describeRejectedMarkup } = await loadRichContentFeedback();
    for (const html of [
      '<p><a href="https://example.com">ссылка</a></p>',
      '<ul><li>раз</li><li>два</li></ul>',
      '<table><tbody><tr><td>ячейка</td></tr></tbody></table>',
    ]) {
      const output = rendered(html);
      expect(output.length, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: граница вырезала ${html} целиком`).toBeGreaterThan(0);
      const report = describeRejectedMarkup(html);
      expect(
        [...report.elements, ...report.attributes],
        `отчёт запрещает разметку, которую граница пропускает: ${html}`,
      ).toEqual([]);
    }
  });
});

/*
 * СЦЕНАРИИ ДЕЛЬТЫ rich-content-safety БЕЗ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * - «черновик сохранён» и «публикация отклонена с указанием непринятого элемента» —
 *   действия РЕДАКТОРА в развёрнутой админке. Проверяется после развёртывания, со
 *   свидетельством (запись, ввод, текст предупреждения, текст отказа). Вычислимая часть
 *   — то, чем предупреждение и отказ наполняются, — покрыта выше.
 * - «на сайте остаётся предыдущее опубликованное состояние записи» — тот же предмет,
 *   плюс сборка из системы управления (change `cms-content-publication`).
 * - «поле системы управления выводится через центральный sink» и «второй sink не
 *   появляется» — уже покрыты обязательным source gate:
 *   `tests/rich-content-contract.test.ts` вместе с
 *   `tests/helpers/rich-content-safety/ast-sinks.ts` (`assertSingletonSinkContract`).
 *   На текущем коде они ЗЕЛЁНЫЕ, и это не случайность: требование дельты как раз
 *   запрещает вводить второй sink, а его сегодня нет. Второй проверки над тем же
 *   предметом здесь не заводится — два гейта над одним предметом расходятся молча.
 */
