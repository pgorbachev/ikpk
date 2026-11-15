export const ARTICLE_SECTION_LABEL = 'Статьи';
export const SEMINAR_COLLECTION_UID = 'api::seminar.seminar';
export const CONTENT_MANAGER_ENTRY_PATH = 'content-manager';
export const SEMINAR_LIST_PATH = `/content-manager/collection-types/${SEMINAR_COLLECTION_UID}`;

/**
 * Strapi открывает «Контент» на первом разделе по алфавиту. Отдельный маршрут
 * без хвоста перехватывает только сам вход и оставляет открытую запись на месте.
 */
export function contentManagerHomeRoute(): { path: string; loader: () => Response } {
  return {
    path: CONTENT_MANAGER_ENTRY_PATH,
    loader: () =>
      new Response(null, {
        status: 302,
        headers: { Location: SEMINAR_LIST_PATH },
      }),
  };
}
