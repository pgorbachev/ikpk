export function assertStudentDocumentFormSnapshot(pages: Record<string, unknown>[] | undefined): void {
  const matches = (pages ?? []).filter((record) => record.slug === 'oplata');
  const address = matches[0]?.student_document_form_url;
  let valid = false;
  if (matches.length === 1 && typeof address === 'string' && address.trim() === address && address.length <= 2048) {
    try {
      const url = new URL(address);
      valid = url.protocol === 'https:' && url.hostname === 'b24-cbqwqo.bitrix24site.ru'
        && !url.username && !url.password && !url.port && !url.hash
        && /^\/crm_form_[a-z0-9]+\/$/.test(url.pathname);
    } catch { /* invalid input fails closed */ }
  }
  if (!valid) throw new Error('snapshot:capture: опубликованная Page /oplata должна содержать единственную действительную ссылку на форму документов; снимок не записан');
}
