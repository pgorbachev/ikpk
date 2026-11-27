import { useEffect, useState } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';
import { useNavigate } from 'react-router-dom';

type Capabilities = { contacts: boolean; books: boolean };

export default function SitePages() {
  const client = useFetchClient();
  const navigate = useNavigate();
  const [capabilities, setCapabilities] = useState<Capabilities>();

  useEffect(() => {
    let active = true;
    Promise.all([
      client.get('/admin/site-phones').then(() => true, (error) => error?.status !== 403),
      client.get('/admin/site-books').then(() => true, () => false),
    ]).then(([contacts, books]) => {
      if (active) setCapabilities({ contacts, books });
    });
    return () => { active = false; };
  }, [client]);

  return <Box padding={8} background="neutral0"><Flex direction="column" alignItems="stretch" gap={4} maxWidth="640px">
    <Typography variant="alpha" tag="h1">Страницы</Typography>
    <Typography>Выберите доступную редактору страницу сайта.</Typography>
    {!capabilities && <Typography>Проверяем права доступа…</Typography>}
    {capabilities?.contacts && <Button variant="secondary" onClick={() => navigate('/content-manager/collection-types/site-contact-phones')}>
      Контакты сайта
    </Button>}
    {capabilities?.books && <Button variant="secondary" onClick={() => navigate('/content-manager/collection-types/site-book-intro')}>
      Вводный текст книг
    </Button>}
    {capabilities && !capabilities.contacts && !capabilities.books &&
      <Typography textColor="danger600">Для этой роли нет разрешённых страниц.</Typography>}
  </Flex></Box>;
}
