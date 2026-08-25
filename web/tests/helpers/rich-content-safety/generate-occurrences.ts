/**
 * Maintainer-only generator: source AST slots + built HTML → occurrence registry.
 * CI MUST NOT invoke this. Run from web/: npx tsx tests/helpers/rich-content-safety/generate-occurrences.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { walkFiles } from '../walk.js';
import {
  collectOccurrences,
  htmlFileRoute,
  projectIdentity,
  provenanceError,
  stripMarkedRegions,
  type OccurrenceRule,
} from './hazard-scan.js';
import { FIXTURES_DIR, REPO_ROOT, WEB_ROOT } from './paths.js';
import type { ExecutableSlot } from './ast-sinks.js';
import { assertCleanGitWorktree } from './git-clean.js';

function loadSlots(): ExecutableSlot[] {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'executable-source-slots.json'), 'utf-8'),
  ) as ExecutableSlot[];
}

/**
 * When several source slots project to the same output identity (dual-theme Rutube:
 * identical root attrs, `svg` provenance ignores body), prefer a slot not yet claimed
 * on this page so both copies get distinct inventory rows instead of a ghost slot.
 */
function matchSlot(
  slots: ExecutableSlot[],
  outputIdentity: string,
  usedSlotIds: Set<string>,
): ExecutableSlot | undefined {
  const pick = (candidates: ExecutableSlot[]): ExecutableSlot | undefined => {
    const unused = candidates.find((slot) => !usedSlotIds.has(slot.slotId));
    return unused ?? candidates[0];
  };
  const exact = slots.filter((slot) => slot.identity === outputIdentity);
  if (exact[0]) return pick(exact);
  const projected = slots.filter((slot) => !provenanceError(slot.identity, outputIdentity));
  if (projected.length === 0) return undefined;
  const output = projectIdentity(outputIdentity);
  if (output.tag === 'link' && (output.staticAttrs.get('rel') ?? '') === 'stylesheet') {
    const imported = projected.filter((slot) => slot.nodeKind === 'css-import');
    if (imported[0]) return pick(imported);
  }
  if (output.tag === 'script' && output.staticAttrs.get('type') === 'module') {
    const bundled = projected.filter((slot) => slot.nodeKind === 'element' && !slot.identity.includes('is:inline'));
    if (bundled[0]) return pick(bundled);
  }
  if (output.tag === 'style') {
    const styles = projected.filter((slot) => slot.identity.startsWith('style|'));
    if (styles[0]) return pick(styles);
  }
  if (output.tag === 'svg') {
    const viewBox = output.staticAttrs.get('viewbox');
    if (viewBox) {
      const sameBox = projected.filter((slot) => slot.identity.includes(viewBox));
      if (sameBox[0]) return pick(sameBox);
    }
  }
  return pick(projected);
}

export function collectRulesFromDist(
  distRoot: string,
  slots: ExecutableSlot[],
  build: 'production' | 'demo',
): {
  rules: OccurrenceRule[];
  unmatched: { route: string; identity: string; placement: string }[];
} {
  const grouped = new Map<string, OccurrenceRule>();
  const unmatched: { route: string; identity: string; placement: string }[] = [];
  for (const file of walkFiles(distRoot, ['.html'])) {
    const html = stripMarkedRegions(readFileSync(file, 'utf-8'));
    const route = htmlFileRoute(file, distRoot);
    const usedSlotIds = new Set<string>();
    for (const found of collectOccurrences(html)) {
      const slot = matchSlot(slots, found.identity, usedSlotIds);
      if (!slot) {
        unmatched.push({ route, identity: found.identity, placement: found.placement });
        continue;
      }
      usedSlotIds.add(slot.slotId);
      const key = `${slot.slotId}\t${route}\t${found.placement}\t${found.identity}`;
      const prev = grouped.get(key);
      if (prev) prev.count += 1;
      else {
        grouped.set(key, {
          slotId: slot.slotId,
          route,
          placement: found.placement,
          identity: found.identity,
          count: 1,
          builds: [build],
        });
      }
    }
  }
  const rules = [...grouped.values()].sort((a, b) => {
    const left = `${a.route}\t${a.slotId}\t${a.placement}`;
    const right = `${b.route}\t${b.slotId}\t${b.placement}`;
    return left.localeCompare(right);
  });
  return { rules, unmatched };
}

export function writeOccurrenceRegistry(occurrences: OccurrenceRule[], extra: {
  generatedFromSha: string;
  distRoots: string[];
}): void {
  const slots = loadSlots();
  const payload = {
    status: 'dist-reviewed',
    generatedFrom: 'source AST + built output; CI must not regenerate',
    generatedFromSha: extra.generatedFromSha,
    distRoots: extra.distRoots,
    ciMustNotRegenerate: true,
    slotIds: slots.map((s) => s.slotId),
    occurrences,
  };
  writeFileSync(join(FIXTURES_DIR, 'output-occurrence-registry.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

function main(): void {
  const sha = assertCleanGitWorktree('generate-occurrences');
  const dist = join(WEB_ROOT, 'dist');
  const demo = join(WEB_ROOT, 'dist-demo');
  const slots = loadSlots();
  const roots: { path: string; build: 'production' | 'demo' }[] = [];
  if (existsSync(dist)) roots.push({ path: dist, build: 'production' });
  if (existsSync(demo)) roots.push({ path: demo, build: 'demo' });
  if (roots.length === 0) {
    throw new Error('нет dist/dist-demo — сначала npm run build и/или npm run build:demo');
  }
  const merged = new Map<string, OccurrenceRule>();
  const unmatched: { route: string; identity: string; placement: string }[] = [];
  for (const root of roots) {
    const { rules, unmatched: miss } = collectRulesFromDist(root.path, slots, root.build);
    unmatched.push(...miss);
    for (const rule of rules) {
      const key = `${rule.slotId}\t${rule.route}\t${rule.placement}\t${rule.identity}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, rule);
        continue;
      }
      prev.count = Math.max(prev.count, rule.count);
      prev.builds = [...new Set([...(prev.builds ?? []), ...(rule.builds ?? [])])];
    }
  }
  if (unmatched.length) {
    const sample = unmatched.slice(0, 20).map((u) => `${u.route} ${u.identity.slice(0, 120)} @ ${u.placement}`);
    throw new Error(`unmatched executable output (${unmatched.length}):\n${sample.join('\n')}`);
  }
  const occurrences = [...merged.values()].sort((a, b) => {
    const left = `${a.route}\t${a.slotId}\t${a.placement}`;
    const right = `${b.route}\t${b.slotId}\t${b.placement}`;
    return left.localeCompare(right);
  });
  // Пути ОТ КОРНЯ РЕПОЗИТОРИЯ, а не абсолютные: абсолютные привязывают фикстуру к машине
  // сборщика и расходятся молча — в committed реестре месяцами лежал
  // `/private/tmp/wt-payment-ux` (worktree чужой сессии), и заметить это было нечем.
  // Гейт «distRoots — пути внутри репозитория» теперь этого не пропустит.
  writeOccurrenceRegistry(occurrences, {
    generatedFromSha: sha,
    distRoots: roots.map((r) => relative(REPO_ROOT, r.path).split(sep).join('/')),
  });
  console.log(`wrote ${occurrences.length} occurrence rules from ${roots.map((r) => r.path).join(', ')}`);
}

if (process.argv[1]?.includes('generate-occurrences')) {
  main();
}
