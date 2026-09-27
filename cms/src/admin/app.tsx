import type { ComponentType } from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 6V3L8 7l4 4V8c2.8 0 5 2.2 5 5 0 1.1-.4 2.1-1 3l1.5 1.5c1-1.3 1.5-2.8 1.5-4.5 0-3.9-3.1-7-7-7zm-5 5c0-1.1.4-2.1 1-3L6.5 6.5C5.5 7.8 5 9.3 5 11c0 3.9 3.1 7 7 7v3l4-4-4-4v3c-2.8 0-5-2.2-5-5z"
      />
    </svg>
  );
}

export default {
  config: {
    locales: ['ru'],
  },
  register(app: StrapiApp) {
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
  },
  bootstrap(app: StrapiApp) {
    app.addMenuLink({
      to: '/site-refresh',
      icon: RefreshIcon,
      intlLabel: { id: 'site-refresh.menu', defaultMessage: 'Обновить сайт' },
      permissions: [],
      Component: () => import('./pages/SiteRefresh'),
    });
  },
};
