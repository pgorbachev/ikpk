import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { refreshStatusLines, type RefreshStatusView } from '../../seminar-management/refresh-status-copy';

type Status = RefreshStatusView & {
  siteUrl?: string | null;
  previousReleaseId?: string | null;
};

export function SiteRefreshPage() {
  const client = useFetchClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');

  async function load() {
    const response = await client.get('/admin/site-refresh');
    setStatus(response.data as Status);
    setError('');
  }

  useEffect(() => {
    load().catch(() => setError('Не удалось прочитать состояние обновления.'));
  }, []);

  useEffect(() => {
    if (status?.status !== 'running') return undefined;
    const timer = window.setInterval(() => {
      load().catch(() => setError('Не удалось прочитать состояние обновления.'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status?.status]);

  async function send(action?: string) {
    setError('');
    try {
      const response = await client.post('/admin/site-refresh', action ? { action } : {});
      setStatus(response.data as Status);
    } catch {
      setError('Запрос не выполнен. Если прав недостаточно, обновить сайт нельзя.');
    }
  }

  const running = status?.status === 'running';
  const lines = refreshStatusLines(status ?? {});

  return (
    <Box padding={8} background="neutral0">
      <Typography variant="alpha" tag="h1">
        Обновить сайт
      </Typography>
      <Box paddingTop={4} paddingBottom={4}>
        <Typography>
          Кнопка публикует весь опубликованный снимок CMS, а не только открытый семинар. Черновики на сайт не
          попадают. Пока идёт сборка, страницу можно закрыть: операция продолжится.
        </Typography>
      </Box>
      <Box paddingBottom={4}>
        <Typography>{lines.message}</Typography>
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
      <Button disabled={running} onClick={() => send()} loading={running}>
        Обновить сайт
      </Button>
      {status?.previousReleaseId ? (
        <Box paddingTop={4}>
          <Button variant="secondary" disabled={running} onClick={() => send('restore')}>
            Вернуть предыдущий релиз
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}

export default SiteRefreshPage;
