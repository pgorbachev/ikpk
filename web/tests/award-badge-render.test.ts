import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { BadgeDeclaration } from '../src/lib/award-badges';

const COMPONENT = join(process.cwd(), 'src', 'components', 'home', 'AwardBadge.astro');

async function render(provider: BadgeDeclaration['provider']): Promise<string> {
  const mod = (await import(pathToFileURL(COMPONENT).href)) as { default: unknown };
  const badge: BadgeDeclaration = {
    id: `${provider.id}-fixture`,
    label: provider.id === 'yandex-maps' ? 'Хорошее место 2026' : 'Здесь хорошо!',
    provider,
    year: 2026,
    sourceUrl: 'https://example.test/card',
    awardEvidence: 'fixture',
    markUsageEvidence: 'fixture',
  };
  const container = await AstroContainer.create();
  return container.renderToString(mod.default as never, { props: { badge } });
}

describe('чип награды соответствует утверждённому variant E', () => {
  it('Яндекс: красная метка на серой круглой подложке и две строки текста', async () => {
    const html = await render({ id: 'yandex-maps', label: 'Яндекс Карты' });
    expect(html).toContain('data-award-provider="yandex-maps"');
    expect(html).toContain('class="award-mark award-mark-ym"');
    expect(html).toContain('width="18" height="18"');
    expect(html).toContain('fill="#fc3f1d"');
    expect(html).toContain('<circle cx="12" cy="8.4" r="2.6" fill="#fff"');
    expect(html).toContain('data-award-title');
    expect(html).toContain('Хорошее место 2026');
    expect(html).toContain('data-award-source');
    expect(html).toContain('Яндекс Карты');
  });

  it('2ГИС: оранжево-зелёная плитка, синяя медаль с белой звездой и две строки текста', async () => {
    const html = await render({ id: '2gis', label: '2ГИС' });
    expect(html).toContain('data-award-provider="2gis"');
    expect(html).toContain('class="award-mark award-mark-gis"');
    expect(html).toContain('<rect x="1" y="3" width="22" height="7" fill="#f2911b"');
    expect(html).toContain('<rect x="1" y="10" width="22" height="11" fill="#5db335"');
    expect(html).toContain('<circle cx="12" cy="11" r="6" fill="#1a8ce0"');
    expect(html).toContain('fill="#fff"');
    expect(html).toContain('Здесь хорошо!');
    expect(html).toContain('2ГИС');
  });

  it('фиксирует размеры, подложку и тень утверждённого чипа', () => {
    const source = readFileSync(COMPONENT, 'utf8');
    expect(source).toMatch(/\.award-mark\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
    expect(source).toMatch(/\.award-mark\s*\{[\s\S]*?border-radius:\s*50%;/);
    expect(source).toMatch(/\.award-mark\s*\{[\s\S]*?background:\s*#f5f6f7;/);
    expect(source).toMatch(/\.award-badge\s*\{[\s\S]*?box-shadow:\s*0 1px 2px rgba\(0, 0, 0, 0\.04\);/);
  });
});
