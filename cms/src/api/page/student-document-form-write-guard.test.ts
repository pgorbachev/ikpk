import assert from 'node:assert/strict';
import test from 'node:test';
import { registerStudentDocumentFormWriteGuard } from './student-document-form-write-guard';

test('ordinary Page create and update paths cannot overwrite the restricted form address', () => {
  let lifecycle: { models: string[]; beforeCreate(event: { params: { data?: Record<string, unknown> } }): void;
    beforeUpdate(event: { params: { data?: Record<string, unknown> } }): void } | undefined;
  registerStudentDocumentFormWriteGuard({ db: { lifecycles: { subscribe(value) { lifecycle = value; } } } });
  assert.deepEqual(lifecycle!.models, ['api::page.page']);
  for (const hook of [lifecycle!.beforeCreate, lifecycle!.beforeUpdate]) {
    const data = { title: 'Unrelated update', student_document_form_url: 'https://attacker.example/' };
    hook({ params: { data } });
    assert.deepEqual(data, { title: 'Unrelated update' });
  }
});
