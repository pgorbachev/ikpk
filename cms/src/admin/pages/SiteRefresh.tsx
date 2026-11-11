import { useEffect, useRef, useState } from 'react';
import { Box, Button, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { refreshStatusLines, SUCCESS_NOTICE_MS, type RefreshStatusView } from '../../seminar-management/refresh-status-copy';

type Status = RefreshStatusView & {
  siteUrl?: string | null;
  previousReleaseId?: string | null;
};

export function SiteRefreshPage() {
  const client = useFetchClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const generation = useRef(0);
  const readIssued = useRef(0);
  const readApplied = useRef(0);

  async function load() {
    const requested = generation.current;
    const sequence = ++readIssued.current;
    try {
      const response = await client.get('/admin/site-refresh');
      if (requested !== generation.current || sendingRef.current || sequence < readApplied.current) return;
      readApplied.current = sequence;
      if (response.data?.status !== 'running') generation.current += 1;
      setStatus(response.data as Status);
      setError('');
    } catch {
      if (requested === generation.current && !sendingRef.current && sequence >= readApplied.current) {
        readApplied.current = sequence;
        setError('Не удалось прочитать состояние обновления.');
      }
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (status?.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status?.status]);

  useEffect(() => {
    const completed = status?.finishedAt ? Date.parse(status.finishedAt) : NaN;
    const remaining = completed + SUCCESS_NOTICE_MS - Date.now();
    setNow(Date.now());
    if (status?.status !== 'succeeded' || !Number.isFinite(remaining) || remaining <= 0 || remaining > SUCCESS_NOTICE_MS) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [status?.status, status?.finishedAt]);

  async function send(action?: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    generation.current += 1;
    setSending(true);
    setError('');
    try {
      const response = await client.post('/admin/site-refresh', action ? { action } : {});
      setStatus(response.data as Status);
    } catch {
      setError('Не удалось получить ответ. Обновите страницу и проверьте состояние операции.');
    } finally {
      generation.current += 1;
      sendingRef.current = false;
      setSending(false);
    }
  }

  const running = status?.status === 'running';
  const lines = refreshStatusLines(status ?? {}, now);

  return (
    <Box padding={8} background="neutral0">
      <Typography variant="alpha" tag="h1">
        Обновить сайт
      </Typography>
      <Box paddingTop={4} paddingBottom={4}>
        <Typography>
          Кнопка обновляет на сайте все материалы, опубликованные в CMS, а не только открытый семинар. Черновики на сайт не
          попадают. Пока идёт обновление, страницу можно закрыть: оно продолжится.
        </Typography>
      </Box>
      <Box paddingBottom={4}>
        {sending ? <Typography>Отправляется запрос…</Typography> : lines.message && !(error && status?.status === 'succeeded') ? <Typography>{lines.message}</Typography> : null}
        {lines.phase ? <Typography tag="p">{lines.phase}</Typography> : null}
        {lines.attempt ? <Typography tag="p">{lines.attempt}</Typography> : null}
        {status?.siteUrl ? (
          <Typography tag="p">
            <a href="/">Открыть сайт</a>
          </Typography>
        ) : null}
      </Box>
      {error ? (
        <Box paddingBottom={4}>
          <Typography textColor="danger600">{error}</Typography>
        </Box>
      ) : null}
      <Button disabled={running || sending} onClick={() => send()} loading={running || sending}>
        Обновить сайт
      </Button>
      {status?.previousReleaseId ? (
        <Box paddingTop={4}>
          <Button variant="secondary" disabled={running || sending} onClick={() => send('restore')}>
            Вернуть предыдущий релиз
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}

export default SiteRefreshPage;
