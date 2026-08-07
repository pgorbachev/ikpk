import { describe, expect, it } from 'vitest';
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
