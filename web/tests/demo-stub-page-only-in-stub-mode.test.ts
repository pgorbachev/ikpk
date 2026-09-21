import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// Страница-заглушка существует ради режима `DEMO_FORMS=stub`: в нём кнопки записи
// ведут на неё вместо CRM. В режиме ХОСТА (свой тестовый портал Bitrix24) на неё не
// ведёт ничто — но собиралась она и там, потому что условие смотрело на `isDemoForms`,
// а он истинен для обоих режимов.
//
// Чем это стоило: заглушка получает `<link rel="canonical">` из `Astro.site`, то есть
// объявляет каноническим `https://ikpk.su/demo-zayavka` — адрес, которого на боевом
// сайте не существует. Пока ожидался `stub`, гейт `form_links_match_mode` видел в этом
// совпадение с образцом `/demo-zayavka` и молчал; стоило объявить хост — и канонический
// адрес самой заглушки стал «ссылкой формы, не соответствующей режиму», и выкладка
// вставала. Отказ был верным по форме и бессмысленным по существу.
describe('страница-заглушка собирается только в режиме stub', () => {
  const src = readFileSync(join(ROOT, 'web', 'src', 'pages', 'demo-zayavka', '[...rest].astro'), 'utf-8');

  it('условие сборки различает режим stub и режим хоста', () => {
    const paths = /export const getStaticPaths\s*=\s*\(\)\s*=>\s*\(([^?]+)\?/.exec(src);
    expect(paths, 'не нашлось getStaticPaths с условием').not.toBeNull();
    const guard = paths![1].trim();
    expect(
      guard,
      'условие опирается на isDemoForms, истинный и для режима хоста: заглушка ' +
        'соберётся там, где на неё никто не ссылается, и принесёт canonical на прод',
    ).not.toBe('isDemoForms');
    expect(guard, 'ожидался признак именно режима stub').toMatch(/stub/i);
  });

  it('признак режима stub объявлен в forms.ts и отличается от isDemoForms', () => {
    const forms = readFileSync(join(ROOT, 'web', 'src', 'lib', 'forms.ts'), 'utf-8');
    expect(forms).toMatch(/export const isDemoStub\b/);
    // Именно равенство 'stub', а не просто непустота — иначе признак повторил бы
    // isDemoForms под другим именем.
    expect(forms).toMatch(/isDemoStub\s*=\s*mode === 'stub'/);
  });
});
