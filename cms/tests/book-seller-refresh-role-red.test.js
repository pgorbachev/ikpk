import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerSiteRefresh } from '../src/seminar-management/site-refresh.ts';

function fixture(t, role = 'strapi-editor') {
  const root = mkdtempSync(join(tmpdir(), 'ikpk-book-refresh-role-'));
  const state = join(root, 'shared', 'site-refresh', 'state.json');
  const previous = process.env.IKPK_REFRESH_STATE;
  mkdirSync(dirname(state), { recursive: true });
  process.env.IKPK_REFRESH_STATE = state;
  const routes = [];
  const strapi = {
    admin: { routes: { admin: { routes } } },
    db: { query: () => ({ findOne: async () => ({ roles: [{ code: role }] }) }) },
  };
  registerSiteRefresh(strapi, { hostPublicationStatus: () => null });
  t.after(() => {
    if (previous === undefined) delete process.env.IKPK_REFRESH_STATE;
    else process.env.IKPK_REFRESH_STATE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    state,
    get: routes.find((route) => route.method === 'GET').handler,
    post: routes.find((route) => route.method === 'POST').handler,
  };
}

test('strapi-editor can read refresh status', async (t) => {
  const f = fixture(t);
  const succeeded = Buffer.from(JSON.stringify({
    status: 'succeeded', phase: 'done', releaseId: 'current', previousReleaseId: 'previous', switched: true,
  }));
  writeFileSync(f.state, succeeded);
  const get = { state: { user: { id: 7 } } };
  await f.get(get);
  assert.equal(get.status, undefined);
  assert.equal(get.body.status, 'succeeded');
});

test('content-admin retains refresh status access', async (t) => {
  const f = fixture(t, 'content-admin');
  writeFileSync(f.state, JSON.stringify({ status: 'succeeded', phase: 'done', releaseId: 'current', switched: true }));
  const ctx = { state: { user: { id: 7 } } };
  await f.get(ctx);
  assert.equal(ctx.status, undefined);
  assert.equal(ctx.body.status, 'succeeded');
});

test('strapi-editor cannot restore or cancel a refresh', async (t) => {
  const f = fixture(t);
  const succeeded = Buffer.from(JSON.stringify({
    status: 'succeeded', phase: 'done', releaseId: 'current', previousReleaseId: 'previous', switched: true,
  }));
  for (const action of [
    { action: 'restore' },
    { action: 'cancel-starting', token: 'a'.repeat(32), ownerPid: process.pid },
  ]) {
    writeFileSync(f.state, succeeded);
    const ctx = { state: { user: { id: 7 } }, request: { body: action } };
    await f.post(ctx);
    assert.equal(ctx.status, 403, `${action.action} must be rejected for strapi-editor`);
    assert.deepEqual(readFileSync(f.state), succeeded, `${action.action} must leave release state untouched`);
  }
});
