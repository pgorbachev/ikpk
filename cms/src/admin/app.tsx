import type { ComponentType } from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';
import { contentManagerHomeRoute } from './content-home';
import { OccurrenceRelations } from './components/OccurrenceRelations';
import OccurrencePrice from './components/OccurrencePrice';
import ArticleCalendarDate from './components/ArticleCalendarDate';
import { SITE_REFRESH_ICON_PATH, siteRefreshIconProps, type SiteRefreshIconProps } from './site-refresh-icon';

function SiteRefreshIcon(props: SiteRefreshIconProps) {
  return (
    <svg {...siteRefreshIconProps(props)}>
      <path fill="currentColor" d={SITE_REFRESH_ICON_PATH} />
    </svg>
  );
}

function PhoneIcon(props: SiteRefreshIconProps) {
  return (
    <svg {...siteRefreshIconProps(props)} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M6.6 10.8a15.5 15.5 0 006.6 6.6l2.2-2.2a1 1 0 011-.24c1.12.37 2.33.57 3.6.57a1 1 0 011 1V20a1 1 0 01-1 1C10.6 21 3 13.4 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.27.2 2.48.57 3.6a1 1 0 01-.25 1z" />
    </svg>
  );
}

export default {
  config: {
    locales: ['ru'],
  },
  register(app: StrapiApp) {
    app.router.addRoute(contentManagerHomeRoute());
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
    // Динамический импорт: модуль конфигурации выполняется и вне браузера
    // (cms/tests/admin-locale.test.js читает `config.locales` без `require`).
    void import('./admin-localization').then(({ ensureDefaultAdminLocale }) =>
      ensureDefaultAdminLocale(window.localStorage),
    );
    void import('./relation-menu').then(({ installRelationMenuWidth }) =>
      installRelationMenuWidth(document),
    );
    app.addMenuLink({
      to: '/site-contact-phones',
      icon: PhoneIcon,
      intlLabel: { id: 'site-phones.menu', defaultMessage: 'Page → Контакты сайта' },
      permissions: [],
      Component: () => import('./pages/SitePhones'),
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
