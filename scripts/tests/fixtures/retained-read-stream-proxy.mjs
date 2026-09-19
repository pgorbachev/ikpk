// Observes/corrupts streams around the existing fake SSH; implements no commands.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
const [logPath, faultJson, ...args] = process.argv.slice(2);
const fault = JSON.parse(faultJson);
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const child = spawn(process.execPath, [fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url)), logPath, '{}', ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
process.stdin.on('data', (chunk) => log({ kind: 'client-bytes', data: chunk.toString('base64') }));
process.stdin.pipe(child.stdin);
child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
child.stdout.pipe(new Transform({
  transform(chunk, _encoding, callback) {
    let bytes = chunk;
    if (fault.replace) {
      const from = Buffer.from(fault.replace.from);
      const to = Buffer.from(fault.replace.to);
      let offset = bytes.indexOf(from);
      while (offset >= 0) {
        bytes = Buffer.concat([bytes.subarray(0, offset), to, bytes.subarray(offset + from.length)]);
        log({ kind: 'corrupted-download', from: fault.replace.from, to: fault.replace.to });
        offset = bytes.indexOf(from, offset + to.length);
      }
    }
    callback(null, bytes);
  },
})).pipe(process.stdout);
