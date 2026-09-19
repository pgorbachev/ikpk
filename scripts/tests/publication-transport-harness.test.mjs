import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.mjs', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test('fake SSH executes a real local command, round-trips streams, writes bytes and injects measured corruption', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ikpk-transport-harness-'));
  try {
    const outputFile = join(temp, 'received payload.bin');
    const logFile = join(temp, 'connections.jsonl');
    const program = 'import pathlib,sys; data=sys.stdin.buffer.read(); pathlib.Path(sys.argv[1]).write_bytes(data); sys.stdout.buffer.write(data)';
    const invoke = (input, fault = {}) => {
      const result = spawnSync(process.execPath, [fakeSsh, logFile, JSON.stringify(fault), '-o', 'StrictHostKeyChecking=yes', 'deploy@transport.test.invalid', `/usr/bin/python3 -c ${quote(program)} ${quote(outputFile)}`], { input, timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr?.toString());
      return result.stdout;
    };
    const bytes = Buffer.from([0, 1, 128, 255, 10, 13, 42]);
    assert.deepEqual(invoke(bytes), bytes);
    assert.deepEqual(readFileSync(outputFile), bytes);

    const tamper = { from: 'VERIFIED-STATIC-PAYLOAD', to: 'CORRUPTD-STATIC-PAYLOAD' };
    assert.equal(invoke(Buffer.from(tamper.from), { tamper }).toString(), tamper.to);
    assert.equal(readFileSync(outputFile, 'utf8'), tamper.to);
    assert.equal(invoke(Buffer.from(Buffer.from(tamper.from).toString('base64')), { tamper }).toString(), Buffer.from(tamper.to).toString('base64'));
    const entries = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries.filter((entry) => entry.kind === 'connection').length, 3);
    assert.equal(entries.filter((entry) => entry.kind === 'corrupted-upload').length, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
