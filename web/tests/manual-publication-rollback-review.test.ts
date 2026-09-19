import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPublicationRollback } from '../scripts/lib/publication-rollback.ts';
import { createPublicationStateStore } from '../scripts/lib/publication-state-store.ts';
import { rollbackFixture } from './helpers/publication-rollback-fixture.ts';

const fixtures: ReturnType<typeof rollbackFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.clean(); });

function fixture(revision: number) {
  const f = rollbackFixture(); fixtures.push(f);
  f.original.revision = revision;
  const author = join(f.temp, 'index-author'); mkdirSync(author);
  const env = { PATH: process.env.PATH!, HOME: f.temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Review fixture', GIT_AUTHOR_EMAIL: 'review@example.invalid',
    GIT_COMMITTER_NAME: 'Review fixture', GIT_COMMITTER_EMAIL: 'review@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(author, 'init', '--initial-branch=state/cms-provenance');
  writeFileSync(join(author, 'verified-pairs.json'), JSON.stringify(f.history));
  git(author, 'add', '.'); git(author, 'commit', '-m', 'stored original publication evidence');
  const remote = join(f.temp, 'state.git'); git(f.temp, 'clone', '--bare', author, remote);
  const store = createPublicationStateStore({ remote, workDir: join(f.temp, 'index-reader'), gitEnv: env });
  const ports = { ...f.ports, state: store };
  return { ...f, ports, store };
}

describe('review: rollback validates evidence before switching with the real state store', () => {
  it('positive control completes and appends without a CMS journal', async () => {
    const f = fixture(7);
    const operation = await runPublicationRollback(f.input, f.ports);
    expect(f.events.some(({ name }) => name === 'switch')).toBe(true);
    expect((await f.store.readHistory()).publications.at(-1)).toEqual(operation);
    expect(f.state.pending).toBeUndefined();
  });

  it.each([0, -1, 1.5])('refuses original revision %s before switching instead of leaving an unrecordable active operation', async (revision) => {
    const f = fixture(revision);
    await expect(runPublicationRollback(f.input, f.ports)).rejects.toThrow();
    expect(f.events.some(({ name }) => name === 'switch'), 'invalid original evidence must be refused before activation').toBe(false);
    expect(f.state.currentReleaseId).toBe(f.newer.releaseId);
    expect(f.state.pending).toBeUndefined();
  });
});
