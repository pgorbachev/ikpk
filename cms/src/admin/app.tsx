import type { ComponentType } from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';
import { OccurrenceRelations } from './components/OccurrenceRelations';
import { SITE_REFRESH_ICON_PATH, siteRefreshIconProps, type SiteRefreshIconProps } from './site-refresh-icon';

function SiteRefreshIcon(props: SiteRefreshIconProps) {
  return (
    <svg {...siteRefreshIconProps(props)}>
      <path fill="currentColor" d={SITE_REFRESH_ICON_PATH} />
    </svg>
  );
}

export default {
  config: {
    locales: ['ru'],
  },
  register(app: StrapiApp) {
    app.addFields({ type: 'relation', Component: OccurrenceRelations });
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
        Input: () => import('./components/OccurrencePrice') as Promise<{ default: ComponentType }>,
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
    app.addMenuLink({
      to: '/site-refresh',
      icon: SiteRefreshIcon,
      intlLabel: { id: 'site-refresh.menu', defaultMessage: 'Обновить сайт' },
      permissions: [],
      Component: () => import('./pages/SiteRefresh'),
    });
  },
};
