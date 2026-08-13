import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTERIZATION_SHA, ENTITIES_DIR, LOCAL_UPLOAD_ORIGINAL, LOCAL_UPLOAD_WEBP, KNOWN_REMOTE_UPLOAD, MEDIA_MANIFEST, REPO_ROOT } from './helpers/rich-content-safety/paths.js';
import {
  assertDiscoveryMatchesRegistry,
  buildSourceRegistry,
  discoverSources,
  matchJsonSelector,
} from './helpers/rich-content-safety/source-discovery.js';
import { fingerprintHtml } from './helpers/rich-content-safety/fingerprint.js';
import { assertManifestComplete, buildMigrationManifest } from './helpers/rich-content-safety/migration.js';
import {
  ALLOWED_EMPTY_INNERHTML,
  allowedEmptyClearKey,
  assertSourceSlotsMatch,
  collectAstroSinks,
  collectExecutableSourceSlots,
  collectTsSinks,
  JSON_LD_FILES,
} from './helpers/rich-content-safety/ast-sinks.js';
import { JSON_SELECTORS, CMS_RICHTEXT_SELECTORS } from './helpers/rich-content-safety/normative.js';
import { loadFixture } from './helpers/rich-content-safety/load-fixture.js';
import type { SourceFingerprint } from './helpers/rich-content-safety/fingerprint.js';
import type { SourceRegistry } from './helpers/rich-content-safety/source-discovery.js';
import type { MigrationRow } from './helpers/rich-content-safety/migration.js';
import type { ExecutableSlot, SinkRecord, TsSinkRecord } from './helpers/rich-content-safety/ast-sinks.js';

const registry = loadFixture<SourceRegistry>('source-registry.json');
const fingerprints = loadFixture<SourceFingerprint[]>('source-fingerprints.json');
const manifest = loadFixture<MigrationRow[]>('migration-manifest.json');
const rawSinks = loadFixture<{ astro: SinkRecord[]; typescript: TsSinkRecord[] }>('raw-sink-registry.json');
const rendered = loadFixture<{
  sinks: { id: string; production: { paths: string[]; count: number } }[];
  jsonLd: { id: string }[];
}>('rendered-registry.json');
const slots = loadFixture<ExecutableSlot[]>('executable-source-slots.json');
const deviation = loadFixture<{
  jsonPath: string;
  remoteUrl: string;
  localAsset: string;
  localOriginalExists: boolean;
  manifestEntry: { width: number; height: number } | null;
  otherRemoteUploadCount: number;
}>('known-deviations.json');

describe('rich-content baseline: source discovery', () => {
  it('нормативный selector list покрыт registry, включая video_playlists и пустые CMS richtext', () => {
    const discovered = discoverSources();
    const errors = assertDiscoveryMatchesRegistry(discovered, registry);
    expect(errors, errors.join('\n')).toEqual([]);
    for (const sel of JSON_SELECTORS) {
      expect(registry.entries.some((e) => e.selectorId === sel.id), sel.id).toBe(true);
    }
    for (const sel of CMS_RICHTEXT_SELECTORS) {
      expect(registry.entries.some((e) => e.selectorId === sel.id), sel.id).toBe(true);
    }
    const playlists = registry.entries.filter((e) => e.selectorId === 'video_playlists[*].description_html');
    expect(playlists.length).toBeGreaterThan(0);
    expect(playlists.some((e) => !e.empty)).toBe(true);
    expect(registry.entries.some((e) => e.selectorId === 'cms:seminar.full_text')).toBe(true);
    expect(registry.entries.some((e) => e.selectorId === 'cms:schedule-entry.description')).toBe(true);
    expect(registry.entries.some((e) => e.selectorId === 'cms:schedule-entry.additionalText')).toBe(true);
  });

  it('живое discovery совпадает с committed registry', () => {
    const live = buildSourceRegistry(discoverSources(), registry.generatedFromSha);
    expect(live.selectors).toEqual(registry.selectors);
    expect(live.entries.map((e) => e.jsonPath)).toEqual(registry.entries.map((e) => e.jsonPath));
  });

  it('zero-match input glob валит discovery', () => {
    expect(() => discoverSources({ entitiesGlob: '*.no-such-json' })).toThrow(/zero-match/);
  });

  it('новое незарегистрированное _html поле валит discovery', () => {
    const discovered = discoverSources({
      extraEntityFiles: [{ name: 'planted.json', json: [{ legacy_id: 'x', planted_html: '<p>x</p>' }] }],
    });
    const errors = assertDiscoveryMatchesRegistry(discovered, registry);
    expect(errors.some((e) => /unlisted HTML-bearing field/.test(e) && /planted_html/.test(e))).toBe(true);
  });

  it('новый CMS type:richtext attribute валит discovery', () => {
    const discovered = discoverSources({
      extraCmsAttributes: [
        { singularName: 'evil-type', attr: 'payload', schemaPath: 'cms/src/api/evil-type/schema.json' },
      ],
    });
    const errors = assertDiscoveryMatchesRegistry(discovered, registry);
    expect(errors.some((e) => /unlisted CMS type:richtext evil-type.payload/.test(e))).toBe(true);
  });
});

describe('rich-content baseline: fingerprints', () => {
  it('source fingerprint сохраняет структуру текущего корпуса', () => {
    const discovered = discoverSources();
    const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h));
    expect(htmlHits.length).toBe(fingerprints.length);
    for (let i = 0; i < htmlHits.length; i += 1) {
      const hit = htmlHits[i];
      const sel = matchJsonSelector(hit)!;
      const live = fingerprintHtml(hit.value, {
        jsonPath: `${hit.file}${hit.jsonPath}`,
        selectorId: sel.id,
        entityId: hit.entityId,
      });
      const committed = fingerprints[i];
      expect(live.sha256, live.jsonPath).toBe(committed.sha256);
      expect(live.headings).toEqual(committed.headings);
      expect(live.links).toEqual(committed.links);
      expect(live.images).toEqual(committed.images);
      expect(live.times).toEqual(committed.times);
      expect(live.rutube).toEqual(committed.rutube);
      expect(live.svgCount).toBe(committed.svgCount);
    }
  });

  it('source-only RUTUBE присутствует в fingerprint, даже если extractor его не выводит', () => {
    const rutube = fingerprints.filter((f) => f.rutube.length > 0);
    expect(rutube.length).toBeGreaterThan(0);
    expect(rutube.some((f) => f.selectorId === 'course_groups[*].description_html')).toBe(true);
  });
});

describe('rich-content baseline: migration manifest', () => {
  it('каждая SVG и mapped style имеет строку manifest', () => {
    const discovered = discoverSources();
    const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h));
    const errors = assertManifestComplete(htmlHits, manifest);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(manifest.length).toBeGreaterThan(0);
    expect(manifest.some((r) => r.kind === 'svg')).toBe(true);
    expect(manifest.some((r) => r.kind === 'style' && r.replacementClass.startsWith('rc-align-'))).toBe(true);
    expect(manifest.some((r) => r.replacementClass === 'rc-display-flex')).toBe(true);
  });

  it('удалённая строка mapped SVG/style валит completeness', () => {
    const discovered = discoverSources();
    const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h));
    const broken = manifest.slice(1);
    const errors = assertManifestComplete(htmlHits, broken);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('повторно собранный manifest совпадает с committed', () => {
    const discovered = discoverSources();
    const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h));
    const courseGroups = JSON.parse(readFileSync(join(ENTITIES_DIR, 'course_groups.json'), 'utf-8'));
    const seminars = JSON.parse(readFileSync(join(ENTITIES_DIR, 'seminars.json'), 'utf-8'));
    const teachers = JSON.parse(readFileSync(join(ENTITIES_DIR, 'teachers.json'), 'utf-8'));
    const live = buildMigrationManifest(htmlHits, { courseGroups, seminars, teachers });
    expect(live.length).toBe(manifest.length);
    expect(live.map((r) => `${r.jsonPath}|${r.kind}|${r.sourceValue}|${r.replacementClass}`)).toEqual(
      manifest.map((r) => `${r.jsonPath}|${r.kind}|${r.sourceValue}|${r.replacementClass}`),
    );
  });
});

describe('rich-content baseline: sinks и rendered registry', () => {
  it('AST raw-sink registry совпадает с committed и отделяет JSON-LD', async () => {
    const live = await collectAstroSinks();
    expect(live.map((s) => s.locator)).toEqual(rawSinks.astro.map((s) => s.locator));
    const jsonLd = live.filter((s) => JSON_LD_FILES.has(s.file));
    expect(jsonLd.every((s) => s.classification === 'json-ld')).toBe(true);
    expect(jsonLd).toHaveLength(2);
    const rich = live.filter((s) => s.classification === 'rich-html');
    expect(rich.length).toBe(14);
  });

  it('четыре точных innerHTML = \'\' и никаких иных TS raw sinks', () => {
    const live = collectTsSinks();
    expect(live.map((s) => s.locator)).toEqual(rawSinks.typescript.map((s) => s.locator));
    expect(live).toHaveLength(4);
    expect(live.every((s) => s.kind === 'innerHTML' && s.allowedEmptyClear)).toBe(true);
    for (const rec of live) {
      expect(ALLOWED_EMPTY_INNERHTML.has(allowedEmptyClearKey(rec)), rec.locator).toBe(true);
    }
  });

  it('rendered registry задаёт sink-id → production/demo paths/counts', () => {
    expect(rendered.jsonLd.map((j) => j.id).sort()).toEqual(['json-ld-breadcrumbs', 'json-ld-head-meta']);
    for (const sink of rendered.sinks) {
      expect(sink.production.count, sink.id).toBeGreaterThanOrEqual(sink.production.paths.length);
      expect(sink.id).toBeTruthy();
    }
    expect(rendered.sinks.some((s) => s.id === 'article-body' && s.production.count === 68)).toBe(true);
    expect(rendered.sinks.some((s) => s.id === 'preview-seminar-body' && s.production.count === 0)).toBe(true);
  });

  it('source AST executable slots one-to-one с committed registry', async () => {
    const live = await collectExecutableSourceSlots();
    const errors = assertSourceSlotsMatch(live, slots);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('замена зарегистрированного source node при том же slotId валит provenance', async () => {
    const live = await collectExecutableSourceSlots();
    const mutated = live.map((s, i) =>
      i === 0 ? { ...s, nodeKind: 'mutated-mechanism', locator: `${s.locator}:replaced` } : s,
    );
    const errors = assertSourceSlotsMatch(mutated, slots);
    expect(errors.some((e) => /изменён source slot/.test(e))).toBe(true);
  });

  it('изменение тела script/style меняет fingerprint и identity', async () => {
    const live = await collectExecutableSourceSlots();
    const script = live.find((s) => s.identity.startsWith('script|') && s.identity.includes('body:'));
    expect(script, 'в source inventory нет inline script с body hash').toBeTruthy();
    const mutated = live.map((s) =>
      s.slotId === script!.slotId
        ? { ...s, identity: `${s.identity}-tampered`, fingerprint: `${s.fingerprint}-tampered` }
        : s,
    );
    const errors = assertSourceSlotsMatch(mutated, slots);
    expect(errors.some((e) => /изменён source slot/.test(e))).toBe(true);
    expect(script!.fingerprint).not.toBe(script!.locator);
  });
});

describe('rich-content baseline: known deviation media', () => {
  it('локальный webp и manifest entry существуют, remote URL — единственное отклонение', () => {
    expect(deviation.remoteUrl).toBe(KNOWN_REMOTE_UPLOAD);
    expect(deviation.localAsset).toBe(LOCAL_UPLOAD_WEBP);
    expect(deviation.localOriginalExists).toBe(true);
    expect(existsSync(LOCAL_UPLOAD_ORIGINAL)).toBe(true);
    expect(deviation.manifestEntry?.width).toBeGreaterThan(0);
    expect(deviation.manifestEntry?.height).toBeGreaterThan(0);
    expect(deviation.otherRemoteUploadCount).toBe(1);
    const media = JSON.parse(readFileSync(MEDIA_MANIFEST, 'utf-8')) as Record<string, { width?: number }>;
    expect(media[LOCAL_UPLOAD_WEBP]?.width).toBeGreaterThan(0);
  });
});

describe('rich-content baseline: пересечения', () => {
  it('preview sinks architecture-frame-prototypes входят в registry', () => {
    const files = rawSinks.astro.map((s) => s.file);
    expect(files).toContain('pages/preview/[variant]/seminar.astro');
    expect(files).toContain('pages/preview/[variant]/seminar-undated.astro');
    expect(files).toContain('components/seminars/SeminarArchitectureHeader.astro');
  });

  it('online-payment-flow пересекается через oplata.astro и не меняет normalizeLegacyControls', () => {
    const proposal = readFileSync(
      join(REPO_ROOT, 'openspec', 'changes', 'online-payment-flow', 'proposal.md'),
      'utf-8',
    );
    expect(proposal).toMatch(/normalizeLegacyControls[`\s]*не меняется/);
    expect(proposal).toMatch(/oplata\.astro/);
    const cleaner = readFileSync(join(REPO_ROOT, 'web', 'src', 'lib', 'html-cleaner.ts'), 'utf-8');
    expect(cleaner).toMatch(/function normalizeLegacyControls/);
    const oplata = readFileSync(join(REPO_ROOT, 'web', 'src', 'pages', 'oplata.astro'), 'utf-8');
    expect(oplata).toContain('cleanBodyHtml');
    expect(oplata).toContain('#oplata-svyaz');
  });

  it('security-registry override — deny-only в dependabot-auto-merge, согласование с dependency-update-gates', () => {
    const autoMerge = readFileSync(
      join(REPO_ROOT, 'openspec', 'changes', 'dependabot-auto-merge', 'proposal.md'),
      'utf-8',
    );
    expect(autoMerge).toMatch(/deny-only/);
    expect(autoMerge).toMatch(/security registry|security dependency registry/i);
    const gates = readFileSync(
      join(REPO_ROOT, 'openspec', 'changes', 'dependency-update-gates', 'proposal.md'),
      'utf-8',
    );
    expect(gates.length).toBeGreaterThan(0);
    const registry = loadFixture<{ runtime: { packages: string[] }; oracle: { packages: string[] } }>(
      'security-dependency-registry.json',
    );
    expect(registry.oracle.packages).toContain('playwright');
  });

  it('characterization SHA зафиксирован', () => {
    expect(CHARACTERIZATION_SHA).toBe('2d48e84db36c013fabcbbe9ba389e1f4debca639');
  });
});

describe('rich-content baseline: rendered fingerprints текущего cleaner-вывода', () => {
  it('cleaner сохраняет headings/tables/markers на корпусе, который реально рендерится', async () => {
    const { cleanBodyHtml } = await import('../src/lib/html-cleaner.js');
    const { htmlOf } = await import('./helpers/rich-content-safety/html-of.js');
    const discovered = discoverSources();
    const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h) && h.value.includes('<table'));
    expect(htmlHits.length, 'в корпусе нет table — vacuous').toBeGreaterThan(0);
    let withMarkers = 0;
    for (const hit of htmlHits) {
      const cleaned = htmlOf(cleanBodyHtml(hit.value));
      const fp = fingerprintHtml(cleaned, {
        jsonPath: `${hit.file}${hit.jsonPath}`,
        selectorId: matchJsonSelector(hit)!.id,
        entityId: hit.entityId,
      });
      expect(fp.tables.length, hit.jsonPath).toBeGreaterThan(0);
      if (fp.markers.some((m) => /table-scroll|data-wrapped/.test(m))) withMarkers += 1;
    }
    expect(withMarkers).toBe(htmlHits.length);
  });
});

describe('rich-content baseline: occurrence registry и generator isolation', () => {
  it('committed occurrence registry ссылается на source slots и не содержит dist-правил до maintainer SHA', () => {
    const occ = loadFixture<{
      ciMustNotRegenerate: boolean;
      occurrences: unknown[];
    }>('output-occurrence-registry.json');
    expect(occ.ciMustNotRegenerate).toBe(true);
    expect(occ.occurrences).toEqual([]);
    expect(slots.length).toBeGreaterThan(0);
  });

  it('CI workflows и npm scripts не вызывают generate-baseline как side effect', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'web', 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toMatch(/generate-baseline/);
    }
    const workflowsDir = join(REPO_ROOT, '.github', 'workflows');
    expect(existsSync(workflowsDir), 'нет .github/workflows — нечем проверить isolation').toBe(true);
    for (const file of readdirSync(workflowsDir)) {
      const text = readFileSync(join(workflowsDir, file), 'utf-8');
      expect(text, file).not.toMatch(/generate-baseline/);
    }
  });

  it('дубликат approved script с тем же identity и другим locator валит provenance', async () => {
    const live = await collectExecutableSourceSlots();
    const extra = {
      ...live[0],
      slotId: `${live[0].slotId}:duplicate`,
      locator: `${live[0].locator}:duplicate`,
    };
    const errors = assertSourceSlotsMatch([...live, extra], slots);
    expect(errors.some((e) => /незарегистрированный source node/.test(e))).toBe(true);
  });
});
