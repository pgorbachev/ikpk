import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_LANGUAGE_STORAGE_KEY,
  DEFAULT_ADMIN_LOCALE,
  ensureDefaultAdminLocale,
} from './admin-localization.ts';

test('новый браузер получает русский язык админки', () => {
  const values = new Map<string, string>();
  ensureDefaultAdminLocale({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });

  assert.equal(DEFAULT_ADMIN_LOCALE, 'ru');
  assert.equal(values.get(ADMIN_LANGUAGE_STORAGE_KEY), 'ru');
});

test('явно выбранный пользователем язык не перезаписывается', () => {
  const values = new Map([[ADMIN_LANGUAGE_STORAGE_KEY, 'en']]);
  ensureDefaultAdminLocale({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });

  assert.equal(values.get(ADMIN_LANGUAGE_STORAGE_KEY), 'en');
});
