// Executes the shipped remote Python, replacing only OS/network boundaries in a child.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [fixture, ...args] = process.argv.slice(2);
const target = args.indexOf('deploy@transport.test.invalid');
if (target < 0 || args.length !== target + 2) throw new Error('isolated SSH target required');
const child = spawn('/usr/bin/env', ['python3', '-I', '-u', fileURLToPath(new URL('./serving-probe-host.py', import.meta.url)), fixture, args[target + 1]], { stdio: ['pipe', 'inherit', 'inherit'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
child.on('exit', (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
