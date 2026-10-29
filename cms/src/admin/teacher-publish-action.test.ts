import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardPublishDescription, shouldGuardTeacherPublication } from './teacher-publish-action';

test('backend capability сохраняет обычное поведение на известных non-SQLite БД и блокирует неизвестную', () => {
  assert.equal(shouldGuardTeacherPublication('postgres'), false);
  assert.equal(shouldGuardTeacherPublication('mysql'), false);
  assert.equal(shouldGuardTeacherPublication('sqlite'), true);
  assert.equal(shouldGuardTeacherPublication(undefined), true);
  assert.equal(shouldGuardTeacherPublication('unknown-driver'), true);
});

test('неполный список подавляет confirmation dialog и не публикует после открытия предупреждения', async () => {
  let status: string | undefined = 'ready';
  let publications = 0;
  const descriptor = {
    onClick: () => undefined,
    dialog: {
      type: 'dialog',
      onConfirm: () => { publications += 1; },
    },
  };
  const guarded = guardPublishDescription(descriptor, 'schedule-entry-doc', () => status);

  const clickResult = await guarded.onClick?.({});
  assert.equal(clickResult, undefined, 'готовый список позволяет штатно открыть предупреждение');
  status = 'loading';
  await guarded.dialog?.onConfirm?.();
  assert.equal(publications, 0, 'confirmation должен перепроверить актуальную готовность перед publish');
});

test('заблокированный click возвращает true, чтобы Strapi не открывал подтверждение', async () => {
  const guarded = guardPublishDescription({ onClick: () => undefined }, 'schedule-entry-doc', () => 'error');
  assert.equal(await guarded.onClick?.({}), true);
});
