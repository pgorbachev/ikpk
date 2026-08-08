import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serializeJsonLd } from '../src/lib/json-ld.js';

// JSON-LD уезжает в страницу через `set:html` внутрь <script type="application/ld+json">
// (HeadMeta.astro, Breadcrumbs.astro). `JSON.stringify` экранирует кавычки JSON, но НЕ
// трогает последовательность `</script>`: строка с ней закрывает тег, и всё, что дальше,
// парсится браузером как разметка. Данные туда приходят из каталога, а не от посетителя,
// поэтому это не наблюдённая эксплуатация, а незакрытый инвариант — и он перестанет быть
// теоретическим ровно в тот день, когда контент поедет из редактируемой CMS.

const PAYLOAD = 'Заголовок</script><img src=x onerror=alert(1)>';

describe('сериализация JSON-LD', () => {
  it('закрывающий тег script не выживает в выводе', () => {
    const out = serializeJsonLd({ '@type': 'Article', headline: PAYLOAD });
    expect(out).not.toContain('</script>');
    // регистр тоже: браузер закрывает тег по </SCRIPT> и </ScRiPt>
    expect(out.toLowerCase()).not.toContain('</script');
  });

  it('данные не искажаются — после разбора строка та же', () => {
    const parsed = JSON.parse(serializeJsonLd({ '@type': 'Article', headline: PAYLOAD }));
    expect(parsed.headline).toBe(PAYLOAD);
  });

  it('обычная схема остаётся читаемым JSON', () => {
    const schema = { '@context': 'https://schema.org', '@type': 'Organization', name: 'ИКПК' };
    expect(JSON.parse(serializeJsonLd(schema))).toEqual(schema);
  });

  // Документирует, ЗАЧЕМ существует функция: голый stringify эту гарантию не даёт.
  // Проверка вечнозелёная и гейтом не является — она объясняет предмет, а не стережёт его.
  it('для сравнения: голый JSON.stringify пропускает закрывающий тег', () => {
    expect(JSON.stringify({ headline: PAYLOAD })).toContain('</script>');
  });
});

// ── Проводка: каждый блок JSON-LD обязан идти через serializeJsonLd ────────────
//
// Находка B9 (docs/security-audit-2026-08-08.md). Проверки выше стерегут ФУНКЦИЮ, а
// не её применение: возврат любого места вставки к голому `JSON.stringify` оставил
// бы их зелёными.
//
// Гейт по ВЫВОДУ в dist эту дыру не закрывает, и это измерено, а не предположено:
// возврат Breadcrumbs.astro к `JSON.stringify` оставил build-набор зелёным
// (77 passed до мутации и 77 после), потому что в текущих данных символа `<` нет
// вовсе — гейт по payload вечнозелёный ровно до появления враждебной строки.
// Поэтому проводка стережётся здесь, по исходникам.

const SRC = join(import.meta.dirname, '..', 'src');

function* astroFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* astroFiles(full);
    else if (full.endsWith('.astro')) yield full;
  }
}

describe('проводка JSON-LD в компонентах', () => {
  it('каждый script[type=ld+json] с set:html сериализуется через serializeJsonLd', () => {
    // Ищем по общему признаку — любой тег с типом ld+json, — а не по списку
    // известных компонентов: новый компонент попадёт под правило сам.
    const tagRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/gi;
    const offenders: string[] = [];
    let tags = 0;

    for (const file of astroFiles(SRC)) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(tagRe)) {
        const tag = m[0];
        const setHtml = /set:html=\{([^}]*)\}/.exec(tag);
        if (!setHtml) continue; // без set:html подставлять нечего
        tags++;
        if (!/\bserializeJsonLd\s*\(/.test(setHtml[1])) {
          offenders.push(`${file.replace(SRC, 'src')}: ${tag.trim()}`);
        }
      }
    }

    // «Проверять нечего» — провал проверки, а не успех: если разметка изменится и
    // регулярка перестанет находить теги, гейт обязан сказать об этом вслух.
    expect(tags, 'в src не найдено ни одного script[type=ld+json] с set:html').toBeGreaterThan(0);
    expect(
      offenders,
      'JSON-LD вставляется мимо serializeJsonLd — экранирование закрывающего тега теряется:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
