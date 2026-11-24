import { useEffect, useState } from 'react';
import { Box, Button, Field, Flex, TextInput, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { PHONE_FIELDS, SITE_PHONE_LABELS, type PhoneField } from '../../lib/site-phones';

type Phones = Record<PhoneField, string | null>;
type ContactView = { draft: Phones; published: Phones; revision: string };

export default function SitePhones() {
  const client = useFetchClient();
  const [view, setView] = useState<ContactView>();
  const [values, setValues] = useState<Phones>({ center_phone: '', manager_phone: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function show(data: ContactView) {
    setView(data);
    setValues(data.draft);
  }

  async function load() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      show((await client.get<ContactView>('/admin/site-phones')).data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить телефоны.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function write(publish: boolean) {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const changes = Object.fromEntries(PHONE_FIELDS.filter((field) => values[field] !== view.draft[field])
        .map((field) => [field, values[field]]));
      const options = { headers: { 'If-Match': `"${view.revision}"` } };
      const response = publish
        ? await client.post<ContactView>('/admin/site-phones/publish', changes, options)
        : await client.put<ContactView>('/admin/site-phones/draft', changes, options);
      show(response.data);
      setMessage(publish ? 'Телефоны опубликованы. Чтобы применить их на сайте, нажмите «Обновить сайт».' : 'Черновик сохранён.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сохранить телефоны.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box padding={8} background="neutral0">
      <Flex direction="column" alignItems="stretch" gap={4} maxWidth="640px">
        <Typography variant="alpha" tag="h1">Контакты сайта</Typography>
        {view && <>
          <Typography>Телефоны для сайта задаются в этих двух полях. Текст Body на странице /kontakty не выводится.</Typography>
          {PHONE_FIELDS.map((field) => (
            <Field.Root key={field} name={field} hint={`Опубликовано: ${view.published[field] || 'не заполнено'}`}>
              <Field.Label>{SITE_PHONE_LABELS[field]}</Field.Label>
              <TextInput type="tel" name={field} disabled={busy} value={values[field] ?? ''}
                onChange={(event) => setValues({ ...values, [field]: event.target.value })} />
              <Field.Hint />
            </Field.Root>
          ))}
          <Flex gap={3}>
            <Button variant="secondary" onClick={() => write(false)} disabled={busy}>Сохранить</Button>
            <Button onClick={() => write(true)} disabled={busy}>Опубликовать</Button>
          </Flex>
        </>}
        {message && <Typography role="status">{message}</Typography>}
        {error && <Box>
          <Typography tag="p" role="alert" textColor="danger600">{error}</Typography>
          <Button variant="tertiary" onClick={load} disabled={busy}>Загрузить актуальные значения</Button>
        </Box>}
      </Flex>
    </Box>
  );
}
