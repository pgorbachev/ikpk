import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStudentDocumentFormUrl, STUDENT_DOCUMENT_FORM_DEFAULT } from './student-document-form';

test('accepts the supplied public form URL and preserves query parameters', () => {
  assert.equal(validateStudentDocumentFormUrl(STUDENT_DOCUMENT_FORM_DEFAULT), null);
  assert.match(new URL(STUDENT_DOCUMENT_FORM_DEFAULT).search, /telemetry_sign=/);
});

for (const value of [
    '', ' ', 'http://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/',
    'https://b24-cbqwqo.bitrix24site.ru.evil.test/crm_form_k5ush/',
    'https://b24-kbo5ls.bitrix24site.ru/crm_form_k5ush/',
    'https://user@b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/',
    'https://b24-cbqwqo.bitrix24site.ru:8443/crm_form_k5ush/',
    'https://b24-cbqwqo.bitrix24site.ru/some-page/',
    'https://b24-cbqwqo.bitrix24site.ru/crm_form_bad-name/',
    'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/#fragment',
]) test(`rejects invalid public form URL ${value || '<empty>'}`, () => {
  assert.notEqual(validateStudentDocumentFormUrl(value), null);
});
