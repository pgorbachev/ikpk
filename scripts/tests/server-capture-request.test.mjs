import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../server-capture-request.sh', import.meta.url));
const id = '4ac8e1cc-d47a-40b0-bce8-67b8124cc9bd';

test('capture request refuses extra units, options, malformed IDs and shell input before systemctl', () => {
  const cases = [[], [id, 'ssh.service'], ['--help'], [`${id} ssh.service`],
    [`${id}\nssh.service`], [`${id}\n`], [`${id};true`], [`$(echo ${id})`],
    ['../' + id], [id.toUpperCase()], [id.replace('-40b0-', '-10b0-')],
    [id.replace('-bce8-', '-7ce8-')], [id.slice(0, -1)], [id + '0']];
  for (const args of cases) {
    const result = spawnSync('/bin/sh', [wrapper, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 64, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('capture request invokes only the fixed system unit with an empty inherited environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikpk-capture-request-'));
  try {
    const systemctl = join(dir, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\nprintf "%s\\n" "$@"\n/usr/bin/env\n', { mode: 0o700 });
    const fixture = join(dir, 'request.sh');
    const source = readFileSync(wrapper, 'utf8');
    assert.equal(source.split('/usr/bin/systemctl').length, 2);
    // Exercise the real wrapper with only its final executable substituted.
    writeFileSync(fixture, source.replace('/usr/bin/systemctl', systemctl), { mode: 0o700 });
    const result = spawnSync('/bin/sh', [fixture, id], { encoding: 'utf8', env: {
      PATH: '/untrusted', IKPK_CAPTURE_ROOT: '/untrusted', NODE_OPTIONS: '--inspect',
      DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/untrusted', SYSTEMD_UNIT_PATH: '/untrusted',
    } });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, 3), ['start', '--', `ikpk-demo-capture@${id}.service`]);
    const environment = Object.fromEntries(lines.slice(3).map((line) => {
      const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(environment.PATH, '/usr/bin:/bin');
    assert.equal(environment.LC_ALL, 'C');
    for (const key of ['NODE_OPTIONS', 'DBUS_SYSTEM_BUS_ADDRESS', 'SYSTEMD_UNIT_PATH', 'IKPK_CAPTURE_ROOT']) {
      assert.equal(environment[key], undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
