// Runs the actual remote command locally. It does not implement transport operations.
// This executable is injected through the module API; no real ssh executable is used.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';

const [logPath, faultJson, ...args] = process.argv.slice(2);
const fault = JSON.parse(faultJson);
const target = args.findIndex((arg) => arg === 'transport.test.invalid' || arg.endsWith('@transport.test.invalid'));
if (target < 0 || target === args.length - 1) throw new Error('fake SSH requires the isolated target and a remote command');
const log = (entry) => appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
log({ kind: 'connection', args });
const remote = spawn('/bin/sh', ['-c', args.slice(target + 1).join(' ')], {
  stdio: ['pipe', 'pipe', 'inherit'], detached: true,
});
// A fresh pipe keeps Python's unbuffered stdout blocking. Inheriting Node's
// nonblocking stdout can silently truncate a large write at the socket capacity.
remote.stdout.pipe(process.stdout);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  try { process.kill(-remote.pid, signal); } catch { /* Already completed. */ }
});
remote.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
remote.on('exit', (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });

const corrupt = new Transform({
  transform(chunk, _encoding, callback) {
    let data = chunk;
    if (fault.tamper) {
      // Corrupt file bytes, whether sent raw (e.g. tar) or base64 (e.g. JSON).
      // No command names or transport protocol operations are recognised here.
      const variants = [
        [Buffer.from(fault.tamper.from), Buffer.from(fault.tamper.to)],
        [Buffer.from(Buffer.from(fault.tamper.from).toString('base64')), Buffer.from(Buffer.from(fault.tamper.to).toString('base64'))],
      ];
      for (const [from, to] of variants) {
        let offset = data.indexOf(from);
        while (offset >= 0) {
          data = Buffer.concat([data.subarray(0, offset), to, data.subarray(offset + from.length)]);
          log({ kind: 'corrupted-upload' });
          offset = data.indexOf(from, offset + to.length);
        }
      }
    }
    callback(null, data);
  },
});
process.stdin.pipe(corrupt).pipe(remote.stdin);
remote.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
