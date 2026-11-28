import assert from 'node:assert/strict';
import test from 'node:test';
import { studentDocumentFormFieldGuard } from './student-document-form-field-guard';

function context(path: string, method: string, body?: unknown) {
  return {
    path, method, request: { body },
    throw(status: number, message: string) { throw Object.assign(new Error(message), { status }); },
  };
}

test('direct Page API and Content Manager writes reject the restricted field', async () => {
  const middleware = studentDocumentFormFieldGuard();
  const requests = [
    context('/api/pages/1', 'PUT', { data: { student_document_form_url: 'https://attacker.example/' } }),
    context('/admin/content-manager/collection-types/api%3A%3Apage.page/doc-1', 'PUT', { data: { student_document_form_url: 'https://attacker.example/' } }),
    context('/admin/content-manager/collection-types/api::page.page/doc-1', 'PUT', { data: {}, student_document_form_url: 'https://attacker.example/' }),
  ];
  for (const ctx of requests) {
    await assert.rejects(() => middleware(ctx, async () => { throw new Error('write continued'); }), error => error.status === 400);
  }
});

test('unrelated Page writes and internal action routes continue; the narrow form endpoint is excluded', async () => {
  const middleware = studentDocumentFormFieldGuard();
  const requests = [
    context('/api/pages/1', 'PUT', { data: { body: 'Updated' } }),
    context('/admin/content-manager/collection-types/api::page.page/doc-1/actions/publish', 'POST', {}),
    context('/admin/site-student-document-form/draft', 'PUT', { student_document_form_url: 'https://approved.example/' }),
  ];
  for (const ctx of requests) {
    let proceeded = false;
    await middleware(ctx, async () => { proceeded = true; });
    assert.equal(proceeded, true);
  }
});
