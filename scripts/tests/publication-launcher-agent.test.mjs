import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CANARY = 'agent-test-payload-a467c2';
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Agent fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Agent fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function run(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('REVIEW: broker-delivered agent socket reaches authorized transport without secret argv or logs', { timeout: 20000 }, async (t) => {
  // Short path keeps the Unix socket below the macOS sockaddr limit.
  const temp = mkdtempSync('/tmp/ikpk-agent-review-'); const socket = join(temp, 'agent.sock');
  const server = createServer((client) => { client.end(CANARY); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); });
  const repo = join(temp, 'author'); const remote = join(temp, 'canonical.git');
  const installed = join(temp, 'protected', 'publication-launcher.mjs'); const configPath = join(dirname(installed), 'config.json');
  const broker = join(dirname(installed), 'broker.mjs'); const brokerTrace = join(temp, 'broker-called');
  const host = join(temp, 'host'); const ssh = join(dirname(installed), 'ssh.mjs'); const trace = join(temp, 'ssh-trace.json');
  const hosts = join(dirname(installed), 'known_hosts');
  mkdirSync(repo); mkdirSync(host); mkdirSync(dirname(installed));
  copyFileSync(join(REPO, 'scripts/publication-launcher.mjs'), installed); chmodSync(installed, 0o700); write(hosts, '# local test adapter\n');
  for (const file of ['publication-launcher.mjs', 'publication-transport.mjs', 'lib/publication-remote.py']) {
    mkdirSync(dirname(join(repo, 'scripts', file)), { recursive: true }); copyFileSync(join(REPO, 'scripts', file), join(repo, 'scripts', file));
  }
  // The adapter first opens the actual configured Unix socket, then runs the real Python transport.
  write(ssh, `import {connect} from 'node:net';import{spawn}from'node:child_process';import{writeFileSync,existsSync}from'node:fs';
const channel=connect(process.env.SSH_AUTH_SOCK??'/missing-agent');let received='';
channel.on('data',b=>received+=b);channel.on('error',()=>process.exit(31));channel.on('end',()=>{
const args=process.argv.slice(2);const agentVerified=received===${JSON.stringify(CANARY)};
writeFileSync(${JSON.stringify(trace)},JSON.stringify({args,agentVerified,brokerCalled:existsSync(${JSON.stringify(brokerTrace)})}));
if(!agentVerified)process.exit(32);const target=args.findIndex(a=>a==='deploy@transport.test.invalid');
const child=spawn('/bin/sh',['-c',args.slice(target+1).join(' ')],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));});\n`);
  write(join(repo, 'scripts/worker.mjs'), `import{mkdirSync,writeFileSync}from'node:fs';import{createSshTransport}from'./publication-transport.mjs';import{digestTree}from'./publication-launcher.mjs';
mkdirSync('fixture-tree');writeFileSync('fixture-tree/index.html','checked bytes');const treeDigest=await digestTree('fixture-tree',['index.html']);
const transport=createSshTransport({host:'transport.test.invalid',user:'deploy',root:${JSON.stringify(host)},destinationId:'stand',knownHostsFile:${JSON.stringify(hosts)},
sshCommand:[process.execPath,${JSON.stringify(ssh)}],authorize:async()=>({destinationId:'stand',commit:'a'.repeat(40),snapshotId:'fixture',treeDigest})});
await transport.withLock(session=>session.stage({releaseId:'agent-probe',sourceDir:'fixture-tree',expectedDigest:treeDigest}));\n`);
  write(join(repo, 'scripts/deploy-web.sh'), `#!/bin/sh\nexec '${process.execPath}' scripts/worker.mjs\n`);
  write(broker, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(brokerTrace)},'called');process.stdout.write(JSON.stringify({env:{SSH_AUTH_SOCK:${JSON.stringify(socket)}}}));\n`);
  write(configPath, JSON.stringify({ canonicalRepository: remote, destinationId: 'stand', deployMode: 'stand',
    sshTarget: 'deploy@transport.test.invalid', credentialBroker: [process.execPath, broker] })); chmodSync(configPath, 0o600);
  git(temp, 'init', '--bare', '--initial-branch=main', remote); git(repo, 'init', '--initial-branch=main');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'trusted worker with transport'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', 'origin', 'main');

  // Positive control proves the same worker, transport, socket and payload are usable.
  const control = await run(['scripts/worker.mjs'], { cwd: repo, env: { ...cleanEnv(), SSH_AUTH_SOCK: socket } });
  assert.equal(control.status, 0, control.stderr); assert.equal(JSON.parse(readFileSync(trace)).agentVerified, true);
  assert.equal(JSON.parse(readFileSync(trace)).brokerCalled, false);
  assert.equal(readFileSync(join(host, 'releases/agent-probe/index.html'), 'utf8'), 'checked bytes');
  rmSync(join(repo, 'fixture-tree'), { recursive: true }); rmSync(host, { recursive: true }); mkdirSync(host); rmSync(trace);

  const result = await run([installed, 'publish', '--config', configPath, '--source-url', remote, '--source-ref', 'main'], { cwd: temp, env: cleanEnv() });
  assert.equal(existsSync(brokerTrace), true, 'the broker must actually deliver the configured socket');
  assert.equal(result.status, 0, `authorized agent handoff failed: ${result.stderr}`);
  assert.equal(JSON.parse(readFileSync(trace)).agentVerified, true); assert.equal(JSON.parse(readFileSync(trace)).brokerCalled, true);
  assert.equal(readFileSync(trace, 'utf8').includes(CANARY), false); assert.equal((result.stdout + result.stderr).includes(CANARY), false);
  assert.equal(readFileSync(join(host, 'releases/agent-probe/index.html'), 'utf8'), 'checked bytes');
});
