export const STUDENT_DOCUMENT_FORM_FIELD = 'student_document_form_url';
export const STUDENT_DOCUMENT_FORM_LABEL = 'Ссылка на форму заполнения документов';
export const STUDENT_DOCUMENT_FORM_HOST = 'b24-cbqwqo.bitrix24site.ru';
export const STUDENT_DOCUMENT_FORM_DEFAULT = 'https://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/?telemetry_sign=v1%3A6%3Adirect_link.2b373ae14476af8c466795c40598e242f26f55b15de21454f4c9dcb4d5acb8c4';

export function validateStudentDocumentFormUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 2048) {
    return 'Введите HTTPS-ссылку на публичную форму документов.';
  }
  let url: URL;
  try { url = new URL(value); } catch { return 'Введите корректную ссылку на публичную форму документов.'; }
  if (url.protocol !== 'https:' || url.hostname !== STUDENT_DOCUMENT_FORM_HOST || url.username || url.password
      || url.port || url.origin !== `https://${STUDENT_DOCUMENT_FORM_HOST}`
      || !/^\/crm_form_[a-z0-9]+\/$/.test(url.pathname) || url.hash) {
    return `Разрешены только публичные CRM-формы портала ${STUDENT_DOCUMENT_FORM_HOST}.`;
  }
  return null;
}
