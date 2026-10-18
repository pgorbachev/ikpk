import assert from 'node:assert/strict';
import {
  provenanceError,
  type OccurrenceRule,
} from './hazard-scan.js';
import type { ExecutableSlot } from './ast-sinks.js';
import type { SnapshotContent } from './snapshot-marker-projection.js';

type Family = 'hierarchical-seminar' | 'flat-seminar' | 'hierarchical-teacher' | 'flat-teacher';

interface RouteFamily {
  id: Family;
  routes: string[];
  prototypeRoute: string;
}

const SITE_ORIGIN = 'https://ikpk.su';
const CANONICAL_RULE = /(?:^|\|)rel=canonical(?:\||$)/;

function uniqueRoutes(routes: string[], family: Family): string[] {
  assert.equal(new Set(routes).size, routes.length, `${family}: duplicate source route`);
  return routes;
}

function canonicalHref(rule: OccurrenceRule, route: string): string {
  assert(CANONICAL_RULE.test(rule.identity), `${route}: canonical occurrence identity is malformed`);
  const expected = `href=${SITE_ORIGIN}${route}`;
  assert(rule.identity.includes(expected), `${route}: canonical identity does not name its source route`);
  assert.equal(rule.identity.split(expected).length - 1, 1, `${route}: canonical href is ambiguous`);
  return expected;
}

function normalizedProfile(rules: OccurrenceRule[], route: string): string {
  const routeRules = rules.filter((rule) => rule.route === route && (!rule.builds || rule.builds.includes('production')));
  assert(routeRules.length > 0, `${route}: no reviewed production occurrence prototype`);
  const canonical = routeRules.filter((rule) => CANONICAL_RULE.test(rule.identity));
  assert.equal(canonical.length, 1, `${route}: expected exactly one canonical occurrence rule`);
  const replace = canonicalHref(canonical[0], route);
  const profile = routeRules.map((rule) => ({
    slotId: rule.slotId,
    identity: rule === canonical[0]
      ? rule.identity.replace(replace, `href=${SITE_ORIGIN}/__dynamic_route__`)
      : rule.identity,
    placement: rule.placement,
    count: rule.count,
    builds: rule.builds ?? [],
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(profile);
}

function projectFamily(
  rules: OccurrenceRule[],
  sourceSlots: ExecutableSlot[],
  family: RouteFamily,
): OccurrenceRule[] {
  uniqueRoutes(family.routes, family.id);
  if (family.routes.length === 0) return rules;

  assert(family.routes.includes(family.prototypeRoute), `${family.id}: reviewed prototype is not source-backed`);
  assert(rules.some((rule) => rule.route === family.prototypeRoute),
    `${family.id}: missing explicit reviewed prototype ${family.prototypeRoute}`);
  const registered = family.routes.filter((route) => rules.some((rule) => rule.route === route));
  assert(registered.length > 0, `${family.id}: no source-backed reviewed prototype route`);
  const prototypeRoute = family.prototypeRoute;
  const prototypeRules = rules.filter((rule) => rule.route === prototypeRoute && (!rule.builds || rule.builds.includes('production')));
  const prototypeProfile = normalizedProfile(rules, prototypeRoute);

  for (const route of registered) {
    assert.equal(normalizedProfile(rules, route), prototypeProfile,
      `${family.id}: reviewed occurrence profiles differ at ${route}`);
  }

  const slotsById = new Map(sourceSlots.map((slot) => [slot.slotId, slot]));
  for (const rule of prototypeRules) {
    assert.notEqual(rule.placement, '*', `${family.id}: wildcard placement in reviewed prototype`);
    const slot = slotsById.get(rule.slotId);
    assert(slot, `${family.id}: missing reviewed source slot ${rule.slotId}`);
    assert.equal(provenanceError(slot.identity, rule.identity), null,
      `${family.id}: prototype identity is not anchored to source slot ${rule.slotId}`);
  }

  const result = [...rules];
  for (const route of family.routes) {
    if (rules.some((rule) => rule.route === route)) continue;
    const sourceCanonical = canonicalHref(
      prototypeRules.find((rule) => CANONICAL_RULE.test(rule.identity))!,
      prototypeRoute,
    );
    result.push(...prototypeRules.map((rule) => ({
      ...rule,
      route,
      identity: CANONICAL_RULE.test(rule.identity)
        ? rule.identity.replace(sourceCanonical, `href=${SITE_ORIGIN}${route}`)
        : rule.identity,
    })));
  }
  return result;
}

/**
 * Adds exact occurrence rules only for source-backed CMS routes absent from the
 * reviewed static registry. Each dynamic route uses one explicit page archetype; its
 * complete reviewed source-slot profile must agree with every already-registered route
 * of that archetype after normalizing the canonical URL only. Expected identities never
 * come from built output.
 */
export function projectSnapshotOccurrences(
  rules: OccurrenceRule[],
  sourceSlots: ExecutableSlot[],
  content: SnapshotContent,
): OccurrenceRule[] {
  const institutes = new Map<string, SnapshotContent['institutes'][number]>();
  for (const institute of content.institutes) {
    assert(institute.slug, 'snapshot institute has empty slug');
    assert(institute.legacy_id, `snapshot institute ${institute.slug} has empty legacy_id`);
    assert(!institutes.has(institute.slug), `duplicate institute slug ${institute.slug}`);
    institutes.set(institute.slug, institute);
  }

  const groups = new Map<string, SnapshotContent['course_groups'][number]>();
  for (const group of content.course_groups) {
    assert(group.legacy_id, 'snapshot course_group has empty legacy_id');
    assert(!groups.has(group.legacy_id), `duplicate course_group legacy_id ${group.legacy_id}`);
    groups.set(group.legacy_id, group);
  }

  const hierarchicalSeminars: string[] = [];
  const flatSeminars: string[] = [];
  for (const seminar of content.seminars) {
    assert(seminar.slug, 'snapshot seminar has empty slug');
    flatSeminars.push(`/seminary/${seminar.slug}`);
    const group = groups.get(seminar.course_group_legacy_id);
    assert(group, `seminar ${seminar.slug}: unknown course_group ${seminar.course_group_legacy_id}`);
    const institute = institutes.get(group.institute_legacy_id);
    assert(institute, `seminar ${seminar.slug}: unknown institute ${group.institute_legacy_id}`);
    hierarchicalSeminars.push(`/${institute.slug}/${group.slug}/${seminar.slug}`);
  }

  const hierarchicalTeachers: string[] = [];
  const flatTeachers: string[] = [];
  for (const teacher of content.teachers) {
    assert(teacher.slug, 'snapshot teacher has empty slug');
    flatTeachers.push(`/specialisty/${teacher.slug}`);
    assert(teacher.institute_legacy_id, `teacher ${teacher.slug}: missing institute relation`);
    const institute = institutes.get(teacher.institute_legacy_id);
    assert(institute, `teacher ${teacher.slug}: unknown institute ${teacher.institute_legacy_id}`);
    hierarchicalTeachers.push(`/${institute.slug}/prepodavatel/${teacher.slug}`);
  }

  const families: RouteFamily[] = [
    {
      id: 'hierarchical-seminar',
      prototypeRoute: '/institut-apledzhera/dolgoletie/kraniosakralnaya-terapiya-dlya-omolozheniya-i-dolgoletiya',
      routes: uniqueRoutes(hierarchicalSeminars, 'hierarchical-seminar'),
    },
    {
      id: 'flat-seminar',
      prototypeRoute: '/seminary/antistressovaya-kineziologiya-2',
      routes: uniqueRoutes(flatSeminars, 'flat-seminar'),
    },
    {
      id: 'hierarchical-teacher',
      prototypeRoute: '/institut-apledzhera/prepodavatel/63',
      routes: uniqueRoutes(hierarchicalTeachers, 'hierarchical-teacher'),
    },
    {
      id: 'flat-teacher',
      prototypeRoute: '/specialisty/53',
      routes: uniqueRoutes(flatTeachers, 'flat-teacher'),
    },
  ];

  return families.reduce((projected, family) => projectFamily(projected, sourceSlots, family), rules);
}
