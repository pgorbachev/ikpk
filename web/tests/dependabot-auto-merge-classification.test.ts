import { describe, expect, it } from 'vitest';
import {
  loadDependabotAutoMerge,
  type ClassificationInput,
  type DependencyUpdate,
} from './helpers/dependabot-auto-merge-contract';

const registry = {
  readable: true,
  consistent: true,
  directPackages: ['parse5', 'playwright'],
  lockfileNodes: ['node_modules/entities', 'node_modules/playwright-core'],
};

const update = (overrides: Partial<DependencyUpdate> = {}): DependencyUpdate => ({
  ecosystem: 'npm',
  packageName: 'web',
  dependencyName: 'astro',
  updateType: 'semver-patch',
  dependencySection: 'production',
  ...overrides,
});

const input = (updates: DependencyUpdate[], overrides: Partial<ClassificationInput> = {}): ClassificationInput => ({
  metadata: { updates },
  securityRegistry: registry,
  changedLockfileNodes: [],
  ...overrides,
});

describe('Dependabot auto-merge classification table', () => {
  it.each([
    ['web patch', update()],
    ['web ordinary production minor', update({ updateType: 'semver-minor' })],
    ['scripts production patch', update({ packageName: 'scripts', dependencyName: 'tsx' })],
    ['scripts production minor', update({ packageName: 'scripts', dependencyName: 'tsx', updateType: 'semver-minor' })],
    ['GitHub Actions minor', update({ ecosystem: 'github-actions', packageName: undefined, dependencyName: 'actions/checkout', updateType: 'semver-minor' })],
  ])('allows %s', async (_label, candidate) => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([candidate]))).toMatchObject({ eligible: true });
  });

  it.each([
    ['GitHub Actions major', update({ ecosystem: 'github-actions', packageName: undefined, updateType: 'semver-major' })],
    ['web major', update({ packageName: 'web', updateType: 'semver-major' })],
    ['scripts major', update({ packageName: 'scripts', updateType: 'semver-major' })],
  ])('keeps %s on the manual path', async (_label, candidate) => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([candidate]))).toMatchObject({
      eligible: false,
      status: 'manual-review',
    });
  });

  it.each([
    ['semver-patch', 'production'],
    ['semver-minor', 'development'],
    ['semver-major', 'production'],
  ] as const)('keeps cms %s (%s) manual', async (updateType, dependencySection) => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([update({ packageName: 'cms', updateType, dependencySection })])))
      .toMatchObject({ eligible: false, status: 'manual-review' });
  });

  it('uses the least permissive member of a grouped PR', async () => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([update(), update({ packageName: 'cms' })])))
      .toMatchObject({ eligible: false, status: 'manual-review' });
  });

  it('fails closed when Dependabot metadata is unavailable', async () => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([], { metadata: null }))).toMatchObject({
      eligible: false,
      status: 'error',
      conclusion: 'failure',
    });
  });

  it.each(['parse5', 'playwright'])('keeps direct security package %s manual', async (dependencyName) => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([update({ dependencyName })]))).toMatchObject({
      eligible: false,
      status: 'manual-review',
    });
  });

  it('keeps a PR manual when an unrelated direct update changes a registered transitive node', async () => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([update()], { changedLockfileNodes: ['node_modules/entities'] })))
      .toMatchObject({ eligible: false, status: 'manual-review' });
  });

  it.each([
    ['missing registry', undefined],
    ['unreadable registry', { ...registry, readable: false }],
    ['stale registry', { ...registry, consistent: false }],
  ])('keeps web manual for %s', async (_label, securityRegistry) => {
    const { classifyPullRequest } = await loadDependabotAutoMerge();
    expect(classifyPullRequest(input([update()], { securityRegistry }))).toMatchObject({
      eligible: false,
      status: 'error',
      conclusion: 'failure',
    });
  });
});
