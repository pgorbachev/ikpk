'use strict';
// Пробная машина: создание super-admin Strapi из СОБРАННОГО артефакта.
//
// Штатная `strapi admin:create-user` здесь не годится: она вызывает `compileStrapi()`, то есть
// `tsc`, а в артефакте нет TS-исходников (только `dist`) — «error TS18003: No inputs were found».
// Скрипт делает то же, что `createAdmin` в Strapi, теми же службами (`admin.services.user.create`
// с ролью strapi-super-admin), но поднимает приложение так же, как `strapi start`: appDir + dist.
// Пароль вводится в терминале без эха и в argv не попадает.
//
// Запуск (делает `deploy/trial/deploy.sh superadmin` через systemd-run от пользователя службы):
//   cd /opt/ikpk-cms/current && node /opt/ikpk-trial/bin/create-super-admin.cjs
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const appDir = process.cwd();
const req = (name) => require(require.resolve(name, { paths: [appDir] }));

let queued = null; // без терминала (тест) все строки читаются один раз: по readline на вопрос буфер теряется
function ask(question) {
  if (!process.stdin.isTTY) {
    queued ??= fs.readFileSync(0, 'utf8').split('\n');
    process.stdout.write(question);
    return Promise.resolve((queued.shift() ?? '').trim());
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function askHidden(question) {
  if (!process.stdin.isTTY) return ask(question); // без терминала (тест): обычная строка
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function passwordProblem(p) {
  if (p.length < 8) return 'минимум 8 символов';
  if (!/[a-z]/.test(p)) return 'нужна строчная буква';
  if (!/[A-Z]/.test(p)) return 'нужна заглавная буква';
  if (!/\d/.test(p)) return 'нужна цифра';
  return null;
}

async function main() {
  const distDir = path.join(appDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'src', 'index.js'))) {
    console.error(`нет собранного приложения: ${distDir}/src/index.js (запускать из каталога релиза CMS)`);
    process.exit(2);
  }
  const email = (await ask('Admin email? ')).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) { console.error('некорректный email'); process.exit(1); }
  const password = await askHidden('Admin password? ');
  const problem = passwordProblem(password);
  if (problem) { console.error(`пароль не принят: ${problem}`); process.exit(1); }
  const firstname = await ask('First name? ');
  if (!firstname) { console.error('имя обязательно'); process.exit(1); }
  const lastname = await ask('Last name? ');
  const confirm = (await ask('Do you really want to create a new admin? [y/N] ')).toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') process.exit(0);

  const { createStrapi } = req('@strapi/core');
  const app = await createStrapi({ appDir, distDir }).load();
  if (await app.admin.services.user.exists({ email })) {
    console.error(`пользователь ${email} уже существует`);
    process.exit(1);
  }
  const superAdminRole = await app.admin.services.role.getSuperAdmin();
  await app.admin.services.user.create({
    email, firstname, lastname, isActive: true, roles: [superAdminRole.id], password, registrationToken: null,
  });
  console.log('Successfully created new admin');
  process.exit(0);
}

main().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
