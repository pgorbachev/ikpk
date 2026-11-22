import { describe, expect, it } from 'vitest';
import { loadDependabotAutoMerge } from './helpers/dependabot-auto-merge-contract';

const node = {
  version: '1.40.0',
  resolved: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.40.0.tgz',
  integrity: 'sha512-same',
  dependencies: { fsevents: '2.3.2', 'playwright-core': '1.40.0' },
  optionalDependencies: { bufferutil: '4.0.8', 'utf-8-validate': '6.0.3' },
  peer: true,
  dev: true,
  license: 'Apache-2.0',
};

describe('registered lockfile node identity', () => {
  it('ignores a peer-only bookkeeping change', async () => {
    const { registeredLockfileNodeChanged } = await loadDependabotAutoMerge();
    expect(registeredLockfileNodeChanged(node, { ...node, peer: false })).toBe(false);
  });

  it('ignores reordered dependency maps and a missing map against an empty one', async () => {
    const { registeredLockfileNodeChanged } = await loadDependabotAutoMerge();
    const flipped = {
      ...node,
      dependencies: Object.fromEntries(Object.entries(node.dependencies).reverse()),
      optionalDependencies: Object.fromEntries(Object.entries(node.optionalDependencies).reverse()),
    };
    expect(registeredLockfileNodeChanged(node, flipped)).toBe(false);
    const withoutOptional = {
      version: node.version,
      resolved: node.resolved,
      integrity: node.integrity,
      dependencies: node.dependencies,
      peer: node.peer,
      dev: node.dev,
      license: node.license,
    };
    expect(registeredLockfileNodeChanged(withoutOptional, { ...node, optionalDependencies: {} })).toBe(false);
  });

  it.each([
    ['version', { version: '1.40.1' }],
    ['resolved', { resolved: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.40.1.tgz' }],
    ['integrity', { integrity: 'sha512-other' }],
    ['dependency edge', { dependencies: { fsevents: '2.3.3', 'playwright-core': '1.40.0' } }],
  ] as const)('treats a changed %s as a different node', async (_label, patch) => {
    const { registeredLockfileNodeChanged } = await loadDependabotAutoMerge();
    expect(registeredLockfileNodeChanged(node, { ...node, ...patch })).toBe(true);
  });

  it('treats a node present on only one side as changed', async () => {
    const { registeredLockfileNodeChanged } = await loadDependabotAutoMerge();
    expect(registeredLockfileNodeChanged(node, undefined)).toBe(true);
    expect(registeredLockfileNodeChanged(undefined, node)).toBe(true);
  });
});
