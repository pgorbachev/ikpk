import { describe, expect, it } from 'vitest';
import {
  loadDependencyUpdateGates,
  type AcceptedPlatformLoss,
  type PlatformEntriesInput,
} from './helpers/dependency-update-gates-contract';

const linuxX64 = { os: ['linux'], cpu: ['x64'], libc: ['glibc'] };
const tuple = '@vendor/binary-linux-x64|linux|x64|glibc';
const otherEntry = { 'node_modules/@other/binary-linux-x64': linuxX64 };
const accepted: AcceptedPlatformLoss = {
  packageName: '@vendor/binary-linux-x64',
  os: 'linux',
  cpu: 'x64',
  libc: 'glibc',
  reason: 'upstream ended glibc distribution',
};

const lockfile = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages });

function input(overrides: Partial<PlatformEntriesInput> = {}): PlatformEntriesInput {
  return {
    baseLockfile: lockfile({
      'node_modules/@vendor/binary-linux-x64': linuxX64,
      ...otherEntry,
    }),
    headLockfile: lockfile({
      'node_modules/@vendor/binary-linux-x64': linuxX64,
      ...otherEntry,
    }),
    baseAcceptedLosses: [],
    headAcceptedLosses: [],
    ...overrides,
  };
}

describe('dependency update gate: platform lockfile entries', () => {
  it('allows removal of a nested duplicate when the same tuple remains at top level', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(
      input({
        baseLockfile: lockfile({
          'node_modules/@vendor/binary-linux-x64': linuxX64,
          'node_modules/tool/node_modules/@vendor/binary-linux-x64': linuxX64,
          ...otherEntry,
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, missingTuples: [] });
  });

  it('detects loss for one package name even when another package preserves the platform', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(
      input({
        headLockfile: lockfile(otherEntry),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.missingTuples).toContain(tuple);
    expect(result.message).toMatch(/@vendor\/binary-linux-x64/);
    expect(result.message).toMatch(/linux.*x64/i);
  });

  it('fails when a tuple disappears completely', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(input({ headLockfile: lockfile(otherEntry) }));
    expect(result).toMatchObject({ ok: false });
    expect(result.missingTuples).toContain(tuple);
  });

  it('allows a named loss with a reason only when the allowance is new in this PR', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(
      input({ headLockfile: lockfile(otherEntry), headAcceptedLosses: [accepted] }),
    );
    expect(result).toMatchObject({ ok: true, missingTuples: [] });
  });

  it('rejects the same loss without an allowance', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    expect(checkPlatformEntries(input({ headLockfile: lockfile(otherEntry) }))).toMatchObject({ ok: false });
  });

  it('rejects a repeated loss authorized only by an allowance already present on base', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(
      input({
        headLockfile: lockfile(otherEntry),
        baseAcceptedLosses: [accepted],
        headAcceptedLosses: [accepted],
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.missingTuples).toContain(tuple);
  });

  it('rejects a stale allowance when the tuple has returned', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(input({ headAcceptedLosses: [accepted] }));
    expect(result).toMatchObject({ ok: false });
    expect(result.staleAllowances).toContain(tuple);
    expect(result.message).toMatch(/remove|stale|устар|убра/i);
  });

  it('keeps an allowance one-shot across the complete accepted-loss lifecycle', async () => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const present = lockfile({ 'node_modules/@vendor/binary-linux-x64': linuxX64, ...otherEntry });
    const missing = lockfile(otherEntry);

    const acceptedLoss = checkPlatformEntries({
      baseLockfile: present,
      headLockfile: missing,
      baseAcceptedLosses: [],
      headAcceptedLosses: [accepted],
    });
    expect(acceptedLoss, 'state 1: a newly accepted named loss').toMatchObject({ ok: true });

    const returnedWithStaleAllowance = checkPlatformEntries({
      baseLockfile: missing,
      headLockfile: present,
      baseAcceptedLosses: [accepted],
      headAcceptedLosses: [accepted],
    });
    expect(returnedWithStaleAllowance, 'state 2: returned tuple invalidates the allowance')
      .toMatchObject({ ok: false, staleAllowances: [tuple] });

    const returnedAfterCleanup = checkPlatformEntries({
      baseLockfile: missing,
      headLockfile: present,
      baseAcceptedLosses: [accepted],
      headAcceptedLosses: [],
    });
    expect(returnedAfterCleanup, 'state 3: removing the stale allowance restores green')
      .toMatchObject({ ok: true });

    const repeatedUnacceptedLoss = checkPlatformEntries({
      baseLockfile: present,
      headLockfile: missing,
      baseAcceptedLosses: [],
      headAcceptedLosses: [],
    });
    expect(repeatedUnacceptedLoss, 'state 4: a later loss needs a new explicit allowance')
      .toMatchObject({ ok: false, missingTuples: [tuple] });
  });

  it.each([
    ['base', input({ baseLockfile: lockfile({}) })],
    ['head', input({ headLockfile: lockfile({}) })],
  ])('fails as not measured when %s lockfile has no platform metadata', async (_label, value) => {
    const { checkPlatformEntries } = await loadDependencyUpdateGates();
    const result = checkPlatformEntries(value);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/platform|metadata|измер|сравн/i);
  });
});
