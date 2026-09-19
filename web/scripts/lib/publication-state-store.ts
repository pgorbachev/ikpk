import type { LedgerEntry, Observation } from './provenance-ledger.ts';
import type { PublicationRecord, VerifiedPair } from './publish-gate.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLedger } from './provenance-ledger.ts';
import { ciEvidenceProblem, isPublicationRecord, localChecksProblem } from './publish-gate.ts';
import { PROVENANCE_BRANCH, VERIFIED_PAIRS_FILE, mergeVerifiedPairs, readVerifiedPairs, upsertVerifiedPair, writeVerifiedPairs } from './verified-pairs.ts';

export interface PublicationStateStoreOptions {
  remote: string;
  workDir: string;
  gitEnv?: Record<string, string>;
  maxPushAttempts?: number;
}
export interface PublicationStateSnapshot {
  head: string;
  observation: Observation;
  entries: readonly LedgerEntry[];
  publications: VerifiedPair[];
}
export interface PublicationStateStore {
  readHistory(): Promise<{ head: string; publications: VerifiedPair[] }>;
  read(fingerprint: string): Promise<PublicationStateSnapshot>;
  appendPublication(record: PublicationRecord): Promise<{ head: string; changed: boolean }>;
  acceptState(input: { expectedObservedEntry: number; fingerprint: string; actor: string }):
    Promise<{ head: string; entry: LedgerEntry & { confirmedBy: string } }>;
}
export class PublicationProvenanceMismatchError extends Error {
  readonly latestEntry: number;
  readonly highWaterMark: number;
  constructor(latestEntry: number, highWaterMark: number) {
    super(`current provenance fingerprint mismatch: latestEntry=${latestEntry} highWaterMark=${highWaterMark}`);
    this.latestEntry = latestEntry;
    this.highWaterMark = highWaterMark;
  }
}
export function createPublicationStateStore(options: PublicationStateStoreOptions): PublicationStateStore {
  const attempts = options.maxPushAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('invalid retry attempt limit');
  const workDir = resolve(options.workDir);
  if (!options.remote || options.remote.startsWith('-')) throw new Error('unsafe state remote');
  if (options.remote.includes('://')) {
    let remote: URL;
    try { remote = new URL(options.remote); } catch { throw new Error('unsafe state remote'); }
    if (remote.password || (remote.protocol !== 'ssh:' && remote.username)) throw new Error('unsafe state remote credentials');
  }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    GIT_AUTHOR_NAME: 'IKPK publication', GIT_AUTHOR_EMAIL: 'publication@ikpk.invalid',
    GIT_COMMITTER_NAME: 'IKPK publication', GIT_COMMITTER_EMAIL: 'publication@ikpk.invalid',
    ...options.gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  let initialized = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(effect: () => Promise<T>): Promise<T> {
    const next = queue.then(effect); queue = next.catch(() => undefined); return next;
  }
  function git(args: string[], cwd = workDir): string {
    try {
      return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
        { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch { throw new Error(`state Git ${args[0]} failed`); }
  }
  function refresh(): string {
    if (!initialized) {
      if (existsSync(workDir)) throw new Error('isolated work directory already exists');
      mkdirSync(dirname(workDir), { recursive: true });
      try {
        git(['clone', '--no-local', '--template=', '--single-branch', '--branch', PROVENANCE_BRANCH, '--', options.remote, workDir], dirname(workDir));
      } catch { throw new Error('provenance state-branch missing or unavailable'); }
      initialized = true;
    }
    git(['fetch', 'origin', `refs/heads/${PROVENANCE_BRANCH}`]);
    git(['reset', '--hard', 'FETCH_HEAD']);
    if (git(['symbolic-ref', '--short', 'HEAD']) !== PROVENANCE_BRANCH) throw new Error('unsafe state branch');
    return git(['rev-parse', 'HEAD']);
  }
  function history() {
    const head = refresh();
    const path = join(workDir, VERIFIED_PAIRS_FILE);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('publication index unavailable or unsafe');
    const publications = readVerifiedPairs(workDir);
    if (mergeVerifiedPairs([], publications).length !== publications.length) throw new Error('duplicate persisted publication index key');
    return { head, publications };
  }
  async function snapshot(fingerprint: string): Promise<PublicationStateSnapshot> {
    const { head, publications } = history(); const dir = join(workDir, 'ledger');
    for (const path of [dir, join(dir, 'high-water-mark')]) {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('provenance ledger unavailable or unsafe');
    }
    const ledger = createLedger({ dir, hasPublicationHistory: true, initialize: false });
    const entries = await ledger.entries();
    const hwm = readFileSync(join(dir, 'high-water-mark'), 'utf8').trim();
    if (!entries.length || !/^\d+$/.test(hwm) || !Number.isSafeInteger(Number(hwm)) || Number(hwm) !== entries.at(-1)!.number ||
      entries.some((entry, i) => entry.number !== i + 1 || entry.previous !== (i === 0 ? null : i) || !entry.fingerprint)) {
      throw new Error('provenance ledger corrupt sequence or high-water-mark');
    }
    return { head, entries, observation: await ledger.observe({ fingerprint }), publications };
  }
  function commit(paths: string[], message: string): void {
    git(['add', '--', ...paths]);
    // Check both the branch and exact staged paths immediately before each commit.
    git(['status', '--short', '--branch']);
    const staged = git(['diff', '--cached', '--name-status']).split('\n').filter(Boolean).map((line) => line.slice(line.indexOf('\t') + 1));
    if (git(['symbolic-ref', '--short', 'HEAD']) !== PROVENANCE_BRANCH || !staged.length || staged.some((path) => !paths.includes(path))) {
      throw new Error('unsafe state commit contents');
    }
    git(['commit', '-m', message]);
  }
  function push(): boolean {
    try { git(['push', 'origin', `HEAD:refs/heads/${PROVENANCE_BRANCH}`]); return true; } catch { return false; }
  }
  return {
    readHistory: () => serial(async () => history()),
    read: (fingerprint) => serial(async () => {
      const state = await snapshot(fingerprint);
      if (!fingerprint || state.entries.at(-1)!.fingerprint !== fingerprint) {
        throw new PublicationProvenanceMismatchError(state.entries.at(-1)!.number, state.observation.highWaterMark);
      }
      return state;
    }),
    appendPublication: (record) => serial(async () => {
      if (!isPublicationRecord(record) || !/^[a-f0-9]{40}$/.test(record.commit) || !/^[a-f0-9]{64}$/.test(record.treeDigest) ||
        !Number.isSafeInteger(record.revision) || record.revision <= 0 || record.testRunConclusion !== 'success' ||
        ciEvidenceProblem(record.ciEvidence, record.commit) || localChecksProblem(record.localChecks, record)) throw new Error('invalid publication evidence');
      for (let attempt = 0; attempt < attempts; attempt++) {
        const state = history();
        const next = upsertVerifiedPair(state.publications, record);
        if (next.length === state.publications.length) return { head: state.head, changed: false };
        writeVerifiedPairs(workDir, next);
        commit([VERIFIED_PAIRS_FILE], `Record publication ${record.publicationId}`);
        if (push()) return { head: git(['rev-parse', 'HEAD']), changed: true };
      }
      throw new Error('publication state push conflict: retry attempts exhausted');
    }),
    acceptState: (input) => serial(async () => {
      if (!input.actor?.trim()) throw new Error('accept-state actor required');
      for (let attempt = 0; attempt < attempts; attempt++) {
        const state = await snapshot(input.fingerprint);
        const last = state.entries.at(-1)!;
        if (last.number !== input.expectedObservedEntry) throw new Error('stale observed-entry confirmation');
        if (last.fingerprint !== input.fingerprint) throw new Error('current fingerprint mismatch');
        const ledger = createLedger({ dir: join(workDir, 'ledger'), hasPublicationHistory: true, initialize: false });
        const entry = await ledger.acceptState({ fingerprint: input.fingerprint, confirmedBy: input.actor });
        commit([`ledger/entry-${String(entry.number).padStart(6, '0')}.json`, 'ledger/high-water-mark'], 'Accept observed CMS state');
        if (push()) return { head: git(['rev-parse', 'HEAD']), entry: entry as LedgerEntry & { confirmedBy: string } };
      }
      throw new Error('accept-state push conflict: retry attempts exhausted');
    }),
  };
}
