import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationOccurrences } from './publication/occurrences';
import { loadFixture } from './helpers/rich-content-safety/load-fixture';
import { matchOccurrences, type OccurrenceRule } from './helpers/rich-content-safety/hazard-scan';
import type { ExecutableSlot } from './helpers/rich-content-safety/ast-sinks';
import { openOracleHarness } from './helpers/rich-content-safety/chromium-oracle';

const rules = loadFixture<{ occurrences: OccurrenceRule[] }>('output-occurrence-registry.json').occurrences;
const slots = loadFixture<ExecutableSlot[]>('executable-source-slots.json');
const article = { title: 'Article', body_text: 'Safe text', published_at: '2026-09-19' };
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function templates(records: typeof article[]) {
  // Attributes emitted by pages/statyi/index.astro:120-124; no executable children.
  return '<select id="articles-sort-select"></select>' + records.map((record, index) =>
    `<template data-article-card data-astro-cid-l6mabxp2 data-page="${Math.floor(index / 6) + 1}" data-title="${escape(record.title.toLowerCase())}" data-body="${escape(record.body_text.slice(0, 300).toLowerCase())}" data-published-at="${escape(record.published_at)}"></template>`,
  ).join('');
}
function projected(records: typeof article[], cmsUrl?: string) {
  return publicationOccurrences(rules, slots, records, 'ci', cmsUrl).filter((rule) => rule.route === '/statyi' && rule.identity.startsWith('template|'));
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('accepts two identical projected identities while rejecting one missing or extra occurrence', () => {
  const records = [article, article];
  expect(matchOccurrences(templates(records), '/statyi', projected(records), slots)).toEqual([]);
  expect(matchOccurrences(templates([article]), '/statyi', projected(records), slots)).not.toEqual([]);
  expect(matchOccurrences(templates([article, article, article]), '/statyi', projected(records), slots)).not.toEqual([]);
});

it('accepts article attributes after the actual snapshot loader localizes CMS media URLs', async () => {
  const captured = { ...article, body_text: 'See https://cms.example.test/uploads/guide.png' };
  const directory = mkdtempSync(join(tmpdir(), 'publication-occurrence-review-'));
  try {
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify({ referenceDate: '2026-09-19', origin: { url: 'https://cms.example.test' }, content: { types: { articles: [captured] } } }));
    vi.stubEnv('CONTENT_SNAPSHOT_DIR', directory);
    vi.resetModules();
    const { getArticles } = await import('../src/lib/data');
    const rendered = getArticles();
    expect(rendered[0].body_text).toBe('See /uploads/guide.png');
    expect(matchOccurrences(templates(rendered as typeof article[]), '/statyi', projected([captured], 'https://cms.example.test'), slots)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('accepts safe nonbreaking spaces after the same Chromium serialization used by the build gate', async () => {
  const records = [{ ...article, title: 'Safe\u00a0title' }];
  const oracle = await openOracleHarness();
  try {
    const parsed = await oracle.parse(templates(records));
    expect(parsed.serialized).toContain('safe&nbsp;title');
    expect(matchOccurrences(parsed.serialized, '/statyi', projected(records), slots)).toEqual([]);
  } finally { await oracle.close(); }
});
