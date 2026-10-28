import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, refreshReady, siteBuildEnv } from '../src/seminar-management/site-refresh-operation.js';
import { resolveDemo193Environment, STAGING194_STATIC_MAIN_CHAT_LOADER_SRC } from '../../web/scripts/demo193-profile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, '../scripts/capture-staging194.py');
const worker = new URL('../src/seminar-management/site-refresh-worker.js', import.meta.url).href;
const put = (path, data, mode = 0o644) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, { mode }); };

// Контракт кнопки: публикуется актуальный снимок, а не только открытая запись.
// Проверяется настоящий адаптер на отдельной SQLite и двух наборах медиа.
test('194 снимок содержит новые опубликованные данные и оба источника медиа без изменения базы', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk194-capture-red-'));
  try {
    const db = join(root, 'cms.sqlite'); const uploads = join(root, 'uploads'); const media = join(root, 'media'); const out = join(root, 'captures');
    mkdirSync(uploads); mkdirSync(media);
    put(join(uploads, 'u.png'), 'uploaded'); put(join(media, 'm.png'), 'site-media');
    const setup = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE content(body TEXT)"); c.execute("INSERT INTO content VALUES (?)",("18-21 февраля, 36 часов",)); c.commit(); c.close()', db], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const env = { ...process.env, IKPK_CAPTURE_PROFILE: 'staging194', IKPK_VERIFY_URL: 'https://194.226.99.10/release.json', IKPK_CAPTURE_DATABASE: db, IKPK_CAPTURE_MEDIA: uploads, IKPK_CAPTURE_ROOT: out, IKPK_MEDIA_CACHE: media };
    const capture = spawnSync('python3', [helper, 'editor-test'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(capture.status, 0, capture.stderr);
    const bundle = join(out, 'editor-test');
    const check = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("SELECT body FROM content").fetchone()[0]); print(c.execute("PRAGMA integrity_check").fetchone()[0])', join(bundle, 'database.sqlite')], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr); assert.equal(check.stdout.trim(), '18-21 февраля, 36 часов\nok');
    const source = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("SELECT body FROM content").fetchone()[0]); print(c.execute("PRAGMA journal_mode").fetchone()[0])', db], { encoding: 'utf8' });
    assert.equal(source.status, 0, source.stderr); assert.equal(source.stdout.trim(), '18-21 февраля, 36 часов\nwal');
    const rows = JSON.parse(readFileSync(join(bundle, 'media-manifest.json'), 'utf8')).media;
    assert.deepEqual(rows.map(r => r.url).sort(), ['/media/m.png', '/uploads/u.png']);
    assert.equal(readFileSync(join(bundle, 'media/uploads/u.png'), 'utf8'), 'uploaded');
    assert.equal(readFileSync(join(bundle, 'media/static-media/m.png'), 'utf8'), 'site-media');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('194 не запускает обновление без компонента снимка, даже когда зависимости установлены', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk194-ready-red-'));
  try {
    put(join(root, 'web/node_modules/astro/package.json'), '{}'); put(join(root, 'web/node_modules/tsx/package.json'), '{}');
    const db = join(root, 'cms.sqlite'); const uploads = join(root, 'uploads'); const out = join(root, 'captures');
    put(db, 'fixture'); mkdirSync(uploads); mkdirSync(out);
    const env = { IKPK_BUILD_WORKSPACE: root, IKPK_CAPTURE_PROFILE: 'staging194', IKPK_VERIFY_URL: 'https://194.226.99.10/release.json', IKPK_CAPTURE_DATABASE: db, IKPK_CAPTURE_MEDIA: uploads, IKPK_CAPTURE_ROOT: out, IKPK_MEDIA_CACHE: '/var/www/ikpk/current/media', IKPK_INSTALLED_COMMIT: 'a'.repeat(40) };
    assert.equal(refreshReady(env), false, 'отсутствующий адаптер должен быть обнаружен до запуска сборки');
    put(join(root, 'cms/scripts/capture-staging194.py'), '# fixture'); put(join(root, 'scripts/lib/seal-staging193-capture.mjs'), '// fixture');
    assert.equal(refreshReady(env), true, 'подготовленный тестовый комплект должен пройти проверку');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('дочерний процесс получает профиль и источник 194 без пароля администратора', () => {
  const env = childEnvironment({ IKPK_CAPTURE_PROFILE: 'staging194', IKPK_CAPTURE_DATABASE: '/test/data.sqlite', IKPK_CAPTURE_MEDIA: '/test/uploads', IKPK_CAPTURE_ROOT: '/test/captures', CONTENT_ADMIN_PASSWORD: 'private' });
  assert.equal(env.IKPK_CAPTURE_PROFILE, 'staging194'); assert.equal(env.IKPK_CAPTURE_DATABASE, '/test/data.sqlite');
  assert.equal(env.IKPK_CAPTURE_MEDIA, '/test/uploads'); assert.equal(env.IKPK_CAPTURE_ROOT, '/test/captures');
  assert.equal(env.CONTENT_ADMIN_PASSWORD, undefined);
});

test('операция 194 строит demo из нового серверного снимка без чата', () => {
  const root = mkdtempSync(join(tmpdir(), 'ikpk194-worker-red-'));
  try {
    const ws = join(root, 'workspace'); const web = join(ws, 'web'); const site = join(root, 'site'); const captures = join(root, 'captures');
    const state = join(root, 'state.json'); const old = join(site, 'releases/previous'); const bin = join(root, 'bin');
    put(join(old, 'release.json'), JSON.stringify({ commit: 'a'.repeat(40), snapshotId: 'snap:old' }));
    spawnSync('ln', ['-s', 'releases/previous', join(site, 'current')]);
    put(join(web, 'node_modules/astro/package.json'), '{}'); put(join(web, 'node_modules/tsx/package.json'), '{}');
    // Контролируемая граница процесса: имитируется свежий снимок с новой записью.
    put(join(ws, 'cms/scripts/capture-staging194.py'), 'import os,sys,pathlib\np=pathlib.Path(os.environ["IKPK_CAPTURE_ROOT"])/sys.argv[1]\np.mkdir(parents=True)\n(p/"database.sqlite").write_text("updated-published")\n');
    put(join(ws, 'scripts/lib/seal-staging193-capture.mjs'), 'import fs from "node:fs"; const p=process.argv[2]; if(fs.readFileSync(p+"/database.sqlite","utf8")!=="updated-published")process.exit(2); fs.writeFileSync(p+"/sealed","yes");');
    put(join(web, 'node_modules/tsx/dist/cli.mjs'), 'import fs from "node:fs"; const a=process.argv.slice(2); const i=a.indexOf("--server-capture"); if(i<0||fs.readFileSync(a[i+1]+"/sealed","utf8")!=="yes") { console.error("sealed fresh capture required"); process.exit(41); } fs.mkdirSync(process.env.CONTENT_SNAPSHOT_DIR,{recursive:true}); fs.writeFileSync(process.env.CONTENT_SNAPSHOT_DIR+"/snapshot.json", JSON.stringify({snapshotId:"snap:new"}));');
    put(join(bin, 'npm'), `#!/bin/sh\n[ "$1 $2" = "run build:demo193" ] || { echo "wrong build profile" >&2; exit 42; }\n[ "$CHAT_LOADER_SRC" = "none" ] || { echo "chat was not declared absent" >&2; exit 43; }\n[ -z "\${CHAT_LOADER_PROFILE+x}" ] || { echo "unexpected chat profile" >&2; exit 44; }\nmkdir -p dist-demo193\nprintf 'new published content' > dist-demo193/index.html\n`, 0o755);
    const runner = `import {readFileSync} from 'node:fs'; import {join} from 'node:path'; globalThis.fetch=async()=>({status:200,json:async()=>JSON.parse(readFileSync(join(process.env.IKPK_WEB_ROOT,'current','release.json'),'utf8'))}); const {executeRefresh}=await import(${JSON.stringify(worker)}); const r=await executeRefresh(); console.log(JSON.stringify(r));`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, IKPK_BUILD_WORKSPACE: ws, IKPK_WEB_ROOT: site, IKPK_REFRESH_STATE: state, IKPK_CAPTURE_PROFILE: 'staging194', IKPK_VERIFY_URL: 'https://194.226.99.10/release.json', IKPK_CAPTURE_DATABASE: join(root,'source.sqlite'), IKPK_CAPTURE_MEDIA: join(root,'uploads'), IKPK_CAPTURE_ROOT: captures, IKPK_MEDIA_CACHE: '/var/www/ikpk/current/media', IKPK_INSTALLED_COMMIT: 'a'.repeat(40) };
    delete env.CHAT_LOADER_SRC; delete env.CHAT_LOADER_PROFILE;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stderr); const result = JSON.parse(run.stdout.trim());
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(JSON.parse(readFileSync(join(site,'current/release.json'),'utf8')).snapshotId, 'snap:new');
    assert.equal(readFileSync(join(site,'current/index.html'),'utf8'), 'new published content');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('профиль публикации из CMS на 194 явно отключает чат и изолирует формы и оплату', () => {
  const previousSrc = process.env.CHAT_LOADER_SRC;
  const previousProfile = process.env.CHAT_LOADER_PROFILE;
  try {
    delete process.env.CHAT_LOADER_SRC;
    delete process.env.CHAT_LOADER_PROFILE;
    // Именно окружение дочернего процесса кнопки, без ручной настройки виджета на хосте.
    const input = { ...childEnvironment(process.env), ...siteBuildEnv('/fixture/workspace', true) };
    const actual = resolveDemo193Environment(input);
    assert.equal(input.CHAT_LOADER_SRC, 'none');
    assert.equal(input.CHAT_LOADER_PROFILE, undefined);
    assert.equal(actual.CHAT_LOADER_PROFILE, undefined);
    assert.equal(actual.CHAT_LOADER_SRC, 'none');
    assert.equal(actual.DEMO_FORMS, 'stub');
    assert.equal(actual.PAYMENT_ROLE, 'ci');
    assert.equal(actual.DEPLOY_MODE, 'stand');
    assert.equal(actual.DEMO_SITE_URL, 'https://194.226.99.10');
  } finally {
    if (previousSrc === undefined) delete process.env.CHAT_LOADER_SRC; else process.env.CHAT_LOADER_SRC = previousSrc;
    if (previousProfile === undefined) delete process.env.CHAT_LOADER_PROFILE; else process.env.CHAT_LOADER_PROFILE = previousProfile;
  }
});

test('отдельный static-main профиль сохраняет утверждённый Bitrix и не допускает неверный адрес', () => {
  const source = { CHAT_LOADER_SRC: STAGING194_STATIC_MAIN_CHAT_LOADER_SRC };
  const staticMain = resolveDemo193Environment({ ...source, CHAT_LOADER_PROFILE: 'staging194-static-main' });
  assert.equal(staticMain.CHAT_LOADER_SRC, STAGING194_STATIC_MAIN_CHAT_LOADER_SRC);
  assert.equal(staticMain.CHAT_LOADER_PROFILE, 'staging194-static-main');
  assert.equal(resolveDemo193Environment(source).CHAT_LOADER_SRC, 'none');
  assert.throws(() => resolveDemo193Environment({ ...source, CHAT_LOADER_PROFILE: 'wrong' }), /CHAT_LOADER_PROFILE/);
  assert.throws(() => resolveDemo193Environment({ CHAT_LOADER_PROFILE: 'staging194-static-main', CHAT_LOADER_SRC: 'https://example.invalid/other.js' }), /owner-approved chat loader/);
});

test('обычный контур не получает дополнительные переменные профиля 194', () => {
  const source = {
    PATH: '/usr/bin', DEMO_PROFILE: 'demo193', DEMO_SITE_URL: 'https://194.226.99.10',
    DEPLOY_MODE: 'stand', CHAT_OFFLINE_MESSAGE: 'absent',
    DEMO_FORMS: 'stub', CHAT_LOADER_SRC: 'https://example.test/existing-loader.js',
  };
  const env = childEnvironment(source);
  for (const key of ['DEMO_PROFILE', 'DEMO_SITE_URL', 'DEPLOY_MODE', 'CHAT_OFFLINE_MESSAGE']) {
    assert.equal(env[key], undefined, `${key} не должен менять сборку другого контура`);
  }
  // Существующие разрешённые переменные продолжают передаваться.
  assert.equal(env.DEMO_FORMS, 'stub');
  assert.equal(env.CHAT_LOADER_SRC, source.CHAT_LOADER_SRC);
});
