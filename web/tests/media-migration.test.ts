import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { dist, walkFiles } from './helpers/dist-pages';

// ─── Этап 2 (план 004): вечный CI-гейт «0 хотлинков на чужой бакет» ─────────
// Все медиа-ассеты самохостятся из public/media (и /terms); ни одна страница
// в dist/ не должна ссылаться на storage.yandexcloud.net.

describe('media migration (Этап 2)', () => {
  it('dist/ contains zero hotlinks to storage.yandexcloud.net', () => {
    const offenders: string[] = [];
    for (const file of walkFiles(dist, ['.html', '.xml', '.css', '.js', '.json', '.txt'])) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('storage.yandexcloud.net')) {
        offenders.push(file.replace(dist, ''));
      }
    }
    expect(offenders, `hotlinks found in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('local media assets are present in dist', () => {
    const mediaDir = join(dist, 'media');
    expect(existsSync(mediaDir)).toBe(true);
    const count = [...walkFiles(mediaDir, ['.webp'])].length;
    expect(count).toBeGreaterThanOrEqual(170);
  });

  it('every /media|/terms reference across ALL dist pages resolves to a local file', () => {
    // Исчерпывающая проверка (не выборка): локализация URL в loadJson безусловна,
    // поэтому недокачанный ассет дал бы тихий 404 — ловим здесь.
    const missing: string[] = [];
    for (const file of walkFiles(dist, ['.html'])) {
      const html = readFileSync(file, 'utf-8');
      const refs = [
        ...html.matchAll(/\b(?:src|href)="(\/(?:media|terms)\/[^"]+)"/gi),
      ].map((m) => m[1]);
      for (const ref of refs) {
        const local = join(dist, decodeURI(ref.split('?')[0]));
        if (!existsSync(local)) missing.push(`${file.replace(dist, '')}: ${ref}`);
      }
    }
    expect(missing, `missing local assets:\n${missing.join('\n')}`).toEqual([]);
  });

  it('content images carry width/height (CLS guard)', () => {
    const html = readFileSync(
      join(dist, 'statyi/90percent-narushenij-v-skeletno-myshechnoj-sisteme/index.html'),
      'utf-8'
    );
    const tags = [...html.matchAll(/<img\b[^>]*\bsrc="\/media\/[^"]*"[^>]*>/gi)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `img lacks dimensions: ${tag}`).toMatch(/\bwidth="\d+"/);
      expect(tag, `img lacks dimensions: ${tag}`).toMatch(/\bheight="\d+"/);
    }
  });
});
