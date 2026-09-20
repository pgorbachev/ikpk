import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLONE_TIMEOUT_MS, GIT_TIMEOUT_MS, gitTimeoutFor } from '../publication-launcher.mjs';

// Сетевой клон канонического источника (pack 323 МиБ на 20.09.2026) не укладывается в общий
// двухминутный лимит git(): на стенде publish отказал source-unavailable. Клон обязан получать
// свой, заведомо больший лимит; локальные команды остаются под коротким.
test('the canonical clone gets a longer git timeout than local commands', () => {
  assert.equal(gitTimeoutFor(['clone', '--template=', '--no-local', '--single-branch', '--branch', 'main', '--', 'url', 'dir']), CLONE_TIMEOUT_MS);
  for (const local of [['rev-parse', 'HEAD'], ['symbolic-ref', 'HEAD'], ['status', '--porcelain'], ['remote', 'get-url', 'origin']]) {
    assert.equal(gitTimeoutFor(local), GIT_TIMEOUT_MS);
  }
  assert.ok(CLONE_TIMEOUT_MS >= 10 * GIT_TIMEOUT_MS, `clone limit ${CLONE_TIMEOUT_MS} must dwarf the local limit ${GIT_TIMEOUT_MS}`);
});
