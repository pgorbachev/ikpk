import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTERIZATION_SHA,
  CONTENT_JSON_DIR,
  FIXTURES_DIR,
  LOCAL_UPLOAD_ORIGINAL,
  LOCAL_UPLOAD_WEBP,
  MEDIA_MANIFEST,
  KNOWN_REMOTE_UPLOAD,
} from './paths.js';
import { discoverSources, buildSourceRegistry, matchJsonSelector } from './source-discovery.js';
import { fingerprintHtml } from './fingerprint.js';
import { buildMigrationManifest } from './migration.js';
import {
  collectAstroSinks,
  collectTsSinks,
  collectExecutableSourceSlots,
} from './ast-sinks.js';
import { loadLockfile, subtreeLockfileNodes } from './lockfile-graph.js';
import { assertCleanGitWorktree } from './git-clean.js';

function loadEntity<T>(name: string): T {
  return JSON.parse(readFileSync(join(CONTENT_JSON_DIR, name), 'utf-8')) as T;
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(join(FIXTURES_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

export async function generateBaselineArtifacts(): Promise<void> {
  const sha = assertCleanGitWorktree('generate-baseline');
  const discovered = discoverSources();
  const sourceRegistry = buildSourceRegistry(discovered, sha);

  const courseGroups = loadEntity<{ legacy_id: string; slug: string; institute_legacy_id: string }[]>(
    'course_groups.json',
  );
  const seminars = loadEntity<{ legacy_id: string; slug: string; course_group_legacy_id: string }[]>(
    'seminars.json',
  );
  const teachers = loadEntity<{ slug: string; institute_legacy_id: string; legacy_id: string }[]>(
    'teachers.json',
  );
  const articles = loadEntity<{ slug: string }[]>('articles.json');
  const institutes = loadEntity<{ slug: string }[]>('institutes.json');
  const news = loadEntity<unknown[]>('news.json');
  const promotions = loadEntity<unknown[]>('promotions.json');

  const lookup = { courseGroups, seminars, teachers };
  const htmlHits = discovered.htmlBearing.filter((h) => matchJsonSelector(h));
  const fingerprints = htmlHits.map((hit) => {
    const sel = matchJsonSelector(hit)!;
    return fingerprintHtml(hit.value, {
      jsonPath: `${hit.file}${hit.jsonPath}`,
      selectorId: sel.id,
      entityId: hit.entityId,
    });
  });

  const manifest = buildMigrationManifest(htmlHits, lookup);
  const astroSinks = await collectAstroSinks();
  const tsSinks = collectTsSinks();
  const executableSlots = await collectExecutableSourceSlots();

  const rendered = buildRenderedRegistry({
    articles,
    institutes,
    courseGroups,
    seminars,
    teachers,
    newsCount: news.length,
    promotionsCount: promotions.length,
  });

  const media = JSON.parse(readFileSync(MEDIA_MANIFEST, 'utf-8')) as Record<
    string,
    { width?: number; height?: number }
  >;
  const knownDeviation = {
    jsonPath: 'course_groups.json$[1].description_html',
    entityId: courseGroups[1]?.legacy_id ?? '',
    remoteUrl: KNOWN_REMOTE_UPLOAD,
    localAsset: LOCAL_UPLOAD_WEBP,
    localOriginalExists: existsSync(LOCAL_UPLOAD_ORIGINAL),
    manifestEntry: media[LOCAL_UPLOAD_WEBP] ?? null,
    otherRemoteUploadCount: htmlHits.filter((h) => h.value.includes('ikpk.su/api/upload')).length,
  };

  writeJson('baseline-meta.json', {
    worktreeHead: sha,
    characterizationSha: CHARACTERIZATION_SHA,
    generatedAt: new Date().toISOString(),
  });
  writeJson('source-registry.json', sourceRegistry);
  writeJson('source-fingerprints.json', fingerprints);
  writeJson('migration-manifest.json', manifest);
  writeJson('raw-sink-registry.json', { astro: astroSinks, typescript: tsSinks });
  writeJson('rendered-registry.json', rendered);
  writeJson('executable-source-slots.json', executableSlots);
  writeJson('known-deviations.json', knownDeviation);
  const oraclePackages = ['playwright'];
  writeJson('security-dependency-registry.json', {
    status: 'pending-implementation',
    runtime: { packages: [], lockfileNodes: [] },
    oracle: {
      packages: oraclePackages,
      lockfileNodes: subtreeLockfileNodes(loadLockfile(), oraclePackages),
    },
    note: 'Реестр заполняется при выборе sanitizer/parser. Пустой runtime — текущий baseline: санитайзера нет. Oracle lockfileNodes — fail-closed снимок текущего playwright subtree.',
  });
  writeJson('output-occurrence-registry.json', {
    status: 'source-inventory-only',
    generatedFrom: 'source AST; dist occurrences заполняются maintainer-командой на reviewed SHA',
    ciMustNotRegenerate: true,
    slotIds: executableSlots.map((s) => s.slotId),
    occurrences: [] as { slotId: string; route: string; placement: string; identity: string; count: number }[],
  });
}

function extractAdditionalHtml(rawHtml: string): string {
  if (!rawHtml) return '';
  const additionalIndex = rawHtml.search(/<h[2-4][^>]*>\s*Дополнительная информация\s*<\/h[2-4]>/i);
  if (additionalIndex >= 0) return rawHtml.slice(additionalIndex);
  const headingPattern = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(rawHtml)) !== null) {
    const headingText = match[1].replace(/<[^>]+>/g, '');
    if (/(профессиональная переподготовка|почему|как проходит обучение|что вы получите|для кого)/i.test(headingText)) {
      return rawHtml.slice(match.index);
    }
  }
  return '';
}

function buildRenderedRegistry(data: {
  articles: { slug: string }[];
  institutes: { slug: string }[];
  courseGroups: { slug: string; institute_legacy_id: string; description_html?: string }[];
  seminars: { slug: string; course_group_legacy_id: string; description_html?: string }[];
  teachers: { slug: string; institute_legacy_id: string }[];
  newsCount: number;
  promotionsCount: number;
}) {
  const cgByLegacy = new Map(
    loadEntity<{ legacy_id: string; slug: string; institute_legacy_id: string }[]>(
      'course_groups.json',
    ).map((c) => [c.legacy_id, c]),
  );
  const groups = loadEntity<{ legacy_id: string; slug: string; institute_legacy_id: string; description_html: string }[]>(
    'course_groups.json',
  );
  const instHtml = loadEntity<{ slug: string; description_html: string }[]>('institutes.json');
  const seminarRows = loadEntity<{ slug: string; course_group_legacy_id: string; description_html: string }[]>(
    'seminars.json',
  );

  const instituteExtra = instHtml
    .filter((i) => extractAdditionalHtml(i.description_html))
    .map((i) => `/${i.slug}`);
  const courseGroupExtra = groups
    .filter((g) => extractAdditionalHtml(g.description_html))
    .map((g) => `/${g.institute_legacy_id}/${g.slug}`);
  const seminarPaths = seminarRows
    .filter((s) => s.description_html.trim())
    .map((s) => {
      const cg = cgByLegacy.get(s.course_group_legacy_id);
      return cg ? `/${cg.institute_legacy_id}/${cg.slug}/${s.slug}` : null;
    })
    .filter((p): p is string => Boolean(p));

  const previewArchitectures = ['editorial', 'faculty', 'modular'];
  const previewSeminar = previewArchitectures.map((id) => `/preview/${id}/seminar`);
  const previewUndated = previewArchitectures.map((id) => `/preview/${id}/seminar-undated`);

  return {
    sinks: [
      {
        id: 'article-body',
        production: { paths: data.articles.map((a) => `/statyi/${a.slug}`), count: data.articles.length },
        demo: { sameAsProduction: true },
      },
      {
        id: 'institute-extra',
        production: { paths: instituteExtra, count: instituteExtra.length },
        demo: { sameAsProduction: true },
      },
      {
        id: 'course-group-extra',
        production: { paths: courseGroupExtra, count: courseGroupExtra.length },
        demo: { sameAsProduction: true },
      },
      {
        id: 'seminar-body',
        production: { paths: seminarPaths, count: seminarPaths.length },
        demo: { sameAsProduction: true },
      },
      {
        id: 'teacher-bio',
        production: {
          paths: data.teachers.map((t) => `/${t.institute_legacy_id}/prepodavatel/${t.slug}`),
          count: data.teachers.length,
        },
        demo: { sameAsProduction: true },
      },
      {
        id: 'static-page-oplata',
        production: { paths: ['/oplata'], count: 1 },
        demo: { sameAsProduction: true },
      },
      {
        id: 'static-page-sotrudnichestvo',
        production: { paths: ['/sotrudnichestvo-s-nami'], count: 1 },
        demo: { sameAsProduction: true },
      },
      {
        id: 'static-page-svedeniya',
        production: { paths: ['/svedeniya-ob-obrazovatelnoy-organizatsii'], count: 1 },
        demo: { sameAsProduction: true },
      },
      {
        id: 'promo-description',
        production: { paths: ['/aktsii-i-skidki'], count: data.promotionsCount },
        demo: { sameAsProduction: true },
      },
      {
        id: 'news-description',
        production: { paths: ['/'], count: data.newsCount },
        demo: {
          paths: ['/', ...previewArchitectures.map((id) => `/preview/${id}`), '/preview/d'],
          count: data.newsCount * (1 + previewArchitectures.length + 1),
        },
      },
      {
        id: 'preview-seminar-body',
        production: { paths: [], count: 0 },
        demo: { paths: previewSeminar.filter((p) => !p.endsWith('/modular/seminar')), count: 2 },
      },
      {
        id: 'preview-seminar-undated-body',
        production: { paths: [], count: 0 },
        demo: { paths: previewUndated.filter((p) => !p.endsWith('/modular/seminar-undated')), count: 2 },
      },
      {
        id: 'seminar-architecture-header',
        production: { paths: [], count: 0 },
        demo: { paths: ['/preview/modular/seminar', '/preview/modular/seminar-undated'], count: 2 },
      },
      {
        id: 'canary-body',
        production: { paths: ['/rich-content-canary'], count: 1 },
        demo: { sameAsProduction: true },
      },
    ],
    jsonLd: [
      { id: 'json-ld-head-meta', note: 'serializeJsonLd invariant' },
      { id: 'json-ld-breadcrumbs', note: 'serializeJsonLd invariant' },
    ],
  };
}

if (process.argv[1]?.includes('generate-baseline')) {
  await generateBaselineArtifacts();
  console.log(`wrote rich-content baseline fixtures to ${FIXTURES_DIR}`);
}
