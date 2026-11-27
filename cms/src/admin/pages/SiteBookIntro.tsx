import { useEffect, useState } from 'react';
import { Box, Button, Field, Flex, Textarea, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

type BookView = { draft: string; published: string; revision: string };

export default function SiteBookIntro() {
  const client = useFetchClient();
  const [view, setView] = useState<BookView>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function show(data: BookView) { setView(data); setValue(data.draft); }
  async function load() {
    setBusy(true); setError(''); setMessage('');
    try { show((await client.get<BookView>('/admin/site-books')).data); }
    catch { setError('Не удалось загрузить вводный текст страницы книг.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  async function write(publish: boolean) {
    if (!view || busy || value === '') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const options = { headers: { 'If-Match': `"${view.revision}"` } };
      const response = publish
        ? await client.post<BookView>('/admin/site-books/publish', { body: value }, options)
        : await client.put<BookView>('/admin/site-books/draft', { body: value }, options);
      setView(response.data);
      setMessage(publish ? 'Текст опубликован в CMS. Чтобы применить его на сайте, нажмите «Обновить сайт».' : 'Черновик сохранён.');
    } catch { setError('Не удалось сохранить: текст мог измениться. Загрузите актуальные значения и повторите правку.'); }
    finally { setBusy(false); }
  }

  return <Box padding={8} background="neutral0"><Flex direction="column" alignItems="stretch" gap={4} maxWidth="720px">
    <Typography variant="alpha" tag="h1">Вводный текст страницы книг</Typography>
    <Typography>Изменяет только абзац о книгах и продавце. Кнопка обновления публикует весь опубликованный снимок CMS, включая другие изменения; черновики на сайт не попадают.</Typography>
    {view && <>
      <Field.Root name="book-intro" hint={`Опубликовано: ${view.published}`}>
        <Field.Label>Вводный текст</Field.Label>
        <Textarea name="book-intro" maxLength={5000} disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} />
        <Field.Hint />
      </Field.Root>
      <Flex gap={3} wrap="wrap">
        <Button variant="secondary" onClick={() => write(false)} disabled={busy || !value.trim() || value === view.draft}>Сохранить черновик</Button>
        <Button onClick={() => write(true)} disabled={busy || !value.trim() || value === view.published}>Опубликовать текст</Button>
      </Flex>
    </>}
    {message && <Typography role="status">{message}</Typography>}
    {error && <Box><Typography tag="p" role="alert" textColor="danger600">{error}</Typography><Button variant="tertiary" onClick={load} disabled={busy}>Загрузить актуальные значения</Button></Box>}
  </Flex></Box>;
}
