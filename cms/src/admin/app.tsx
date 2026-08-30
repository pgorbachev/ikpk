import type { StrapiApp } from '@strapi/strapi/admin';

export default {
  register(app: StrapiApp) {
    app.customFields.register({
      name: 'tiptap-html',
      type: 'text',
      intlLabel: {
        id: 'tiptap-html.label',
        defaultMessage: 'Визуальный HTML-редактор (PoC)',
      },
      intlDescription: {
        id: 'tiptap-html.description',
        defaultMessage: 'HTML хранится в базе; редактор и таблицы загружаются из локальной сборки.',
      },
      components: {
        Input: async () => import('./components/TiptapHtmlInput'),
      },
    });
  },
};
