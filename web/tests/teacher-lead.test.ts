import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { teacherLead } from '../src/lib/teacher-lead';

// Краткое описание преподавателя на странице института. Аудит паритета показал
// два дефекта: часть описаний начиналась с середины фразы (первым символом
// запятая или строчная буква), а у основателя института выпадала главная строка
// позиционирования — потому что отбор паррагафов отбрасывал всё, где встречалось
// слово «институт».
const teachers = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'discovery', 'entities', 'teachers.json'), 'utf-8'),
) as Array<{ name: string; bio_html: string; bio_text: string }>;

describe('краткое описание преподавателя', () => {
  it('никогда не начинается с середины фразы', () => {
    const offenders: string[] = [];
    for (const t of teachers) {
      const lead = teacherLead(t.bio_html, t.bio_text, t.name);
      if (!lead) continue;
      // признаки обрыва: начало со знака препинания или со строчной буквы
      if (/^[,;:.)»—-]/.test(lead) || /^[а-яё]/.test(lead)) {
        offenders.push(`${t.name}: «${lead.slice(0, 60)}…»`);
      }
    }
    expect(
      offenders.slice(0, 5),
      `описание начинается с середины фразы (${offenders.length}):\n${offenders.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });

  it('у основателя сохраняется строка позиционирования', () => {
    const founder = teachers.find((t) => /Пилявский/.test(t.name));
    expect(founder, 'основатель не найден в данных').toBeTruthy();
    const lead = teacherLead(founder!.bio_html, founder!.bio_text, founder!.name);
    expect(lead, `описание основателя: «${lead}»`).toMatch(/основатель/i);
  });

  it('обрывается по границе предложения или слова, а не посреди слова', () => {
    const offenders: string[] = [];
    for (const t of teachers) {
      const lead = teacherLead(t.bio_html, t.bio_text, t.name);
      if (lead.endsWith('…') && /[а-яёa-z]…$/i.test(lead)) {
        // многоточие сразу после буквы допустимо только если перед ним целое слово
        const beforeEllipsis = lead.slice(0, -1);
        if (!/[\s.,;:!?)»]$/.test(beforeEllipsis) && beforeEllipsis.split(/\s+/).pop()!.length < 3) {
          offenders.push(`${t.name}: «…${lead.slice(-40)}»`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

// Биографии приходят из API списками <li>, а не абзацами. Если склеивать пункты
// одним пробелом, получается бессмысленная строка: «…дипломант прикладной
// кинезиологии (DIBAK) Вице-президент…» — конец одного пункта сросся с началом
// следующего. Пункты списка нужно разделять явно.
describe('биография списком', () => {
  // только биографии, где описание СОБИРАЕТСЯ из списка: если есть годный
  // абзац, он и станет описанием, и проверять разделители не на чем.
  const hasUsableParagraph = (html: string): boolean =>
    [...(html || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].some((m) => {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return text.length >= 20 && !/[:：]$/.test(text);
    });

  const listBios = teachers.filter(
    (t) => /<li[\s>]/i.test(t.bio_html || '') && !hasUsableParagraph(t.bio_html || ''),
  );

  it('в данных действительно есть биографии списком', () => {
    expect(listBios.length).toBeGreaterThan(0);
  });

  it('пункты списка разделены, а не склеены пробелом', () => {
    const offenders: string[] = [];
    for (const t of listBios) {
      const lead = teacherLead(t.bio_html, t.bio_text, t.name);
      const items = [...t.bio_html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].length;
      // если в описание попало больше одного пункта, между ними должен быть
      // разделитель, а не просто пробел
      if (items > 1 && lead.length > 80 && !/[;.] /.test(lead)) {
        offenders.push(`${t.name}: «${lead.slice(0, 80)}…»`);
      }
    }
    expect(
      offenders.slice(0, 5),
      `пункты списка склеены (${offenders.length}):\n${offenders.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });
});
