import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const worker = new URL('../../../cms/src/seminar-management/site-refresh-worker.js', import.meta.url).href;
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);

export function refreshStaging194(fixture: { snapshotDir: string; outDir: string; buildNow: string }, mutation?: string, changeAfterCheck = false) {
  const root = mkdtempSync(join(tmpdir(), 'ikpk194-cta-refresh-'));
  const put = (file: string, content: string, mode = 0o644) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
  };
  try {
    const workspace = join(root, 'workspace');
    const web = join(workspace, 'web');
    const site = join(root, 'site');
    const bin = join(root, 'bin');
    const state = join(root, 'state.json');
    const token = 'a'.repeat(32);
    const previous = 'releases/previous';
    put(join(site, previous, 'release.json'), JSON.stringify({ commit, snapshotId: 'snap:old' }));
    put(join(site, '.publication.lock'), '', 0o600);
    symlinkSync(previous, join(site, 'current'));
    put(state, JSON.stringify({
      status: 'running', phase: 'starting', pid: process.pid, refreshOperationToken: token,
      startedAt: new Date().toISOString(), switched: false,
    }));
    mkdirSync(web, { recursive: true });
    symlinkSync(join(repo, 'web/scripts'), join(web, 'scripts'));
    symlinkSync(join(repo, 'web/src'), join(web, 'src'));
    symlinkSync(join(repo, 'web/public'), join(web, 'public'));
    symlinkSync(join(repo, 'web/package.json'), join(web, 'package.json'));
    mkdirSync(join(web, 'node_modules/tsx/dist'), { recursive: true });
    symlinkSync(join(repo, 'web/node_modules/astro'), join(web, 'node_modules/astro'));
    put(join(web, 'node_modules/tsx/package.json'), '{}');
    put(join(web, 'node_modules/tsx/dist/cli.mjs'), `
      import fs from 'node:fs';
      import { join } from 'node:path';
      import { spawnSync } from 'node:child_process';
      if (process.argv[2] !== 'scripts/capture-content-snapshot.ts') {
        if (${changeAfterCheck} && process.argv[3] === 'confirm') {
          fs.appendFileSync(join(process.argv[4], 'raspisanie-i-tseny/index.html'), '<!-- candidate changed -->');
        }
        const result = spawnSync(process.execPath, [${JSON.stringify(join(repo, 'web/node_modules/tsx/dist/cli.mjs'))}, ...process.argv.slice(2)],
          { stdio: 'inherit' });
        process.exit(result.status ?? 1);
      }
      const source = ${JSON.stringify(fixture.snapshotDir)};
      const destination = process.env.CONTENT_SNAPSHOT_DIR;
      fs.cpSync(source, destination, { recursive: true });
    `);
    put(join(workspace, 'cms/scripts/capture-staging194.py'), 'import os,sys,pathlib\n(pathlib.Path(os.environ["IKPK_CAPTURE_ROOT"])/sys.argv[1]).mkdir(parents=True)\n');
    put(join(workspace, 'scripts/lib/seal-staging193-capture.mjs'), '');
    put(join(bin, 'npm'), `#!/bin/sh
[ "$1 $2" = "run build:demo193" ] || exit 42
"${process.execPath}" "${join(root, 'candidate.cjs')}"
`, 0o755);
    const built = join(root, 'build-probe');
    put(join(root, 'candidate.cjs'), `
      const fs = require('node:fs');
      fs.cpSync(${JSON.stringify(fixture.outDir)}, 'dist-demo193', { recursive: true });
      ${mutation ?? ''}
      fs.writeFileSync(${JSON.stringify(built)}, 'built');
    `);
    const runner = `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const DateAtBuild = Date;
      globalThis.Date = class extends DateAtBuild {
        constructor(...args) { super(...(args.length ? args : [${JSON.stringify(fixture.buildNow)}])); }
      };
      globalThis.fetch = async () => ({ status: 200, json: async () =>
        JSON.parse(readFileSync(join(process.env.IKPK_WEB_ROOT, 'current', 'release.json'), 'utf8')) });
      const { executeRefresh } = await import(${JSON.stringify(worker)});
      const result = await executeRefresh({ registryReader: () => ({
        CONTENT_HISTORICAL_EXCEPTIONS_FILE: '/fixed/root-owned/registry.json',
        CONTENT_HISTORICAL_EXCEPTIONS_SHA256: '${digest}'
      }) });
      console.log(JSON.stringify(result));
    `;
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, IKPK_BUILD_WORKSPACE: workspace,
      IKPK_WEB_ROOT: site, IKPK_REFRESH_STATE: state, IKPK_CAPTURE_PROFILE: 'staging194',
      IKPK_VERIFY_URL: 'https://194.226.99.10/release.json', IKPK_CAPTURE_DATABASE: join(root, 'source.sqlite'),
      IKPK_CAPTURE_MEDIA: join(root, 'uploads'), IKPK_CAPTURE_ROOT: join(root, 'captures'),
      IKPK_MEDIA_CACHE: '/var/www/ikpk/current/media', IKPK_INSTALLED_COMMIT: commit,
      SEMINAR_BUILD_NOW: fixture.buildNow, IKPK_REFRESH_OWNER_PID: String(process.pid), IKPK_REFRESH_OPERATION_TOKEN: token,
    };
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { env, encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(built), run.stdout + run.stderr).toBe(true);
    return { result: JSON.parse(run.stdout.trim()), current: readlinkSync(join(site, 'current')),
      active: JSON.parse(readFileSync(join(site, 'current/release.json'), 'utf8')), previous };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
