import type { ComponentType } from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';
import { contentManagerHomeRoute } from './content-home';
import { OccurrenceRelations } from './components/OccurrenceRelations';
import OccurrencePrice from './components/OccurrencePrice';
import ArticleCalendarDate from './components/ArticleCalendarDate';
import { SITE_REFRESH_ICON_PATH, siteRefreshIconProps, type SiteRefreshIconProps } from './site-refresh-icon';
import { hideUnneededEditFields } from './edit-form-fields';

function SiteRefreshIcon(props: SiteRefreshIconProps) {
  return (
    <svg {...siteRefreshIconProps(props)}>
      <path fill="currentColor" d={SITE_REFRESH_ICON_PATH} />
    </svg>
  );
}

type EditViewLayout = {
  layout: {
    components: Record<string, {
      layout: { name: string; label?: string; hint?: string }[][];
    }>;
  };
};

type CollectionLinks = { ctLinks: { uid: string; title: string }[] };

const pageTranslations = {
  Page: 'Страницы',
  'content-manager.content-types.api::page.page.body': 'Текст страницы',
};

export default {
  config: {
    locales: ['ru'],
    translations: { ru: pageTranslations, en: pageTranslations },
  },
  register(app: StrapiApp) {
    app.router.addRoute(contentManagerHomeRoute());
    app.router.addRoute({
      path: 'site-contact-phones',
      loader: () => new Response(null, {
        status: 302,
        headers: { Location: '/content-manager/collection-types/site-contact-phones' },
      }),
    });
    app.router.addRoute((routes) => routes.map((route) => {
      if (route.path !== 'content-manager/*') return route;
      return {
        ...route,
        children: [
          ...(route.children ?? []),
          {
            path: 'collection-types/site-pages',
            lazy: async () => ({ Component: (await import('./pages/SitePages')).default }),
          },
          {
            path: 'collection-types/site-contact-phones',
            lazy: async () => ({ Component: (await import('./pages/SitePhones')).default }),
          },
          {
            path: 'collection-types/site-book-intro',
            lazy: async () => ({ Component: (await import('./pages/SiteBookIntro')).default }),
          },
          {
            path: 'collection-types/site-student-document-form',
            lazy: async () => ({ Component: (await import('./pages/SiteStudentDocumentForm')).default }),
          },
        ],
      };
    }));
    app.addFields({ type: 'relation', Component: OccurrenceRelations });
    app.addFields({ type: 'datetime', Component: ArticleCalendarDate });
    app.customFields.register({
      name: 'wall-clock-datetime',
      type: 'datetime',
      intlLabel: { id: 'wall-clock-datetime.label', defaultMessage: 'Дата и время' },
      intlDescription: {
        id: 'wall-clock-datetime.description',
        defaultMessage: 'Календарный день сохраняется в зоне браузера',
      },
      components: {
        Input: () => import('./components/WallClockDateTime') as Promise<{ default: ComponentType }>,
      },
    });
    app.customFields.register({
      name: 'occurrence-city',
      type: 'string',
      intlLabel: { id: 'occurrence-city.label', defaultMessage: 'Город проведения' },
      intlDescription: { id: 'occurrence-city.description', defaultMessage: 'Отключается для онлайн-проведения' },
      components: {
        Input: () => import('./components/OccurrenceCity') as Promise<{ default: ComponentType }>,
      },
    });
    app.customFields.register({
      name: 'occurrence-price',
      type: 'decimal',
      intlLabel: { id: 'occurrence-price.label', defaultMessage: 'Цена проведения' },
      intlDescription: { id: 'occurrence-price.description', defaultMessage: 'Пустая цена означает, что она уточняется' },
      components: {
        Input: async () => ({ default: OccurrencePrice }),
      },
    });
    app.customFields.register({
      name: 'occurrence-duration',
      type: 'string',
      intlLabel: { id: 'occurrence-duration.label', defaultMessage: 'Продолжительность проведения' },
      intlDescription: { id: 'occurrence-duration.description', defaultMessage: 'Наследуется из опубликованного семинара, если не переопределена' },
      components: {
        Input: () => import('./components/OccurrenceDuration') as Promise<{ default: ComponentType }>,
      },
    });
  },
  bootstrap(app: StrapiApp) {
    app.registerHook('Admin/CM/pages/EditView/mutate-edit-view-layout', hideUnneededEditFields);
    // Динамический импорт: модуль конфигурации выполняется и вне браузера
    // (cms/tests/admin-locale.test.js читает `config.locales` без `require`).
    void import('./admin-localization').then(({ ensureDefaultAdminLocale }) =>
      ensureDefaultAdminLocale(window.localStorage),
    );
    void import('./relation-menu').then(({ installRelationMenuWidth }) =>
      installRelationMenuWidth(document),
    );
    // The sidebar searches and sorts these titles before translating them.
    app.registerHook('Admin/CM/pages/App/mutate-collection-types-links', (input: CollectionLinks) => ({
      ...input,
      ctLinks: input.ctLinks.map(link =>
        link.uid === 'api::page.page' ? { ...link, title: pageTranslations.Page } : link),
    }));
    app.registerHook('Admin/CM/pages/EditView/mutate-edit-view-layout', (input: EditViewLayout) => {
      const seo = input.layout.components['shared.seo'];
      if (!seo) return input;
      const layout = seo.layout
        .map(row => row.map(field => {
          if (field.name === 'og_image') {
            return {
              ...field,
              label: 'Обложка ссылки',
              hint: 'Используется для ссылок на программы, семинары и статьи. Если оставить поле пустым, сайт покажет общую обложку ИКПК.',
            };
          }
          if (field.name === 'og_title') return { ...field, label: 'Open Graph Title' };
          if (field.name === 'og_description') return { ...field, label: 'Open Graph Description' };
          return field;
        }));
      return { ...input, layout: { ...input.layout, components: { ...input.layout.components, 'shared.seo': { ...seo, layout } } } };
    });
    app.addMenuLink({
      to: '/site-refresh',
      icon: SiteRefreshIcon,
      intlLabel: { id: 'site-refresh.menu', defaultMessage: 'Обновить сайт' },
      permissions: [],
      Component: () => import('./pages/SiteRefresh'),
    });
  },
};
