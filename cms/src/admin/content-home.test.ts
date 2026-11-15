import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMemoryRouter } from 'react-router-dom';
import {
  ARTICLE_SECTION_LABEL,
  CONTENT_MANAGER_ENTRY_PATH,
  SEMINAR_LIST_PATH,
  contentManagerHomeRoute,
} from './content-home.ts';

test('раздел Article называется «Статьи», адрес типа не меняется', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../api/article/content-types/article/schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.info.displayName, ARTICLE_SECTION_LABEL);
  assert.equal(schema.info.singularName, 'article');
  assert.equal(schema.info.pluralName, 'articles');
});

test('вход в контент открывает семинары и не перехватывает уже открытый раздел', async () => {
  const home = contentManagerHomeRoute();
  assert.equal(home.path, CONTENT_MANAGER_ENTRY_PATH);
  const response = home.loader();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), SEMINAR_LIST_PATH);

  const openedArticle = '/content-manager/collection-types/api::article.article';
  const router = createMemoryRouter(
    [
      { path: 'content-manager/*', loader: () => ({ layout: true }) },
      home,
    ],
    { initialEntries: ['/content-manager', openedArticle], initialIndex: 0 },
  );
  await waitUntilIdle(router);
  assert.equal(router.state.location.pathname, SEMINAR_LIST_PATH);

  await router.navigate(openedArticle);
  await waitUntilIdle(router);
  assert.equal(router.state.location.pathname, openedArticle);
});

function waitUntilIdle(router: ReturnType<typeof createMemoryRouter>): Promise<void> {
  if (router.state.navigation.state === 'idle') return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.navigation.state === 'idle') {
        unsubscribe();
        resolve();
      }
    });
  });
}
