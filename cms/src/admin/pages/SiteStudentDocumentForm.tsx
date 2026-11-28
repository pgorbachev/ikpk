import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Flex, TextInput, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

type View = { draft: string; published: string; revision: string };
const label = 'Ссылка на форму заполнения документов';

export default function SiteStudentDocumentForm() {
  const client = useFetchClient();
  const [view, setView] = useState<View>();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(''); setBusy(true);
    try { const next = (await client.get<View>('/admin/site-student-document-form')).data; setView(next); setValue(next.draft); }
    catch { setError('Не удалось загрузить адрес формы. Обновите значения и повторите попытку.'); }
    finally { setBusy(false); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (publish: boolean) => {
    if (!view) return;
    setBusy(true); setError('');
    try {
      const response = publish
        ? await client.post<View>('/admin/site-student-document-form/publish', { student_document_form_url: value }, { headers: { 'If-Match': `"${view.revision}"` } })
        : await client.put<View>('/admin/site-student-document-form/draft', { student_document_form_url: value }, { headers: { 'If-Match': `"${view.revision}"` } });
      setView(response.data); setValue(response.data.draft);
    } catch (cause: any) {
      setError(cause?.status === 409 ? 'Адрес изменился в другой вкладке. Загрузите актуальные значения.' : cause?.response?.data?.error?.message ?? 'Не удалось сохранить адрес формы.');
    } finally { setBusy(false); }
  };
  return <Box padding={8} background="neutral0"><Flex direction="column" alignItems="stretch" gap={4} maxWidth="760px">
    <Typography variant="alpha" tag="h1">Оплата</Typography>
    <Typography>Ссылка станет доступна на сайте после публикации и успешного обновления сайта.</Typography>
    <TextInput label={label} name="student_document_form_url" value={value} onChange={event => setValue(event.currentTarget.value)} disabled={busy} />
    {view && <Typography>Опубликовано: {view.published || 'адрес пока не опубликован'}</Typography>}
    {error && <Typography textColor="danger600" role="alert">{error}</Typography>}
    <Flex gap={3}>
      <Button variant="secondary" onClick={() => void submit(false)} disabled={busy || !view}>Сохранить черновик</Button>
      <Button onClick={() => void submit(true)} disabled={busy || !view}>Опубликовать адрес</Button>
      <Button variant="tertiary" onClick={() => void load()} disabled={busy}>Загрузить актуальные значения</Button>
    </Flex>
  </Flex></Box>;
}
