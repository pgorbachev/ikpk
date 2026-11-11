/**
 * Пункт меню «Обновить сайт».
 *
 * Strapi рисует иконки меню как `<Icon width="20" height="20" fill="neutral500" />`
 * во viewBox 32. Прежняя иконка обновления игнорировала эти атрибуты и оставалась
 * `1em` — меньше и бледнее соседних. `fill` из меню — имя цвета темы, не CSS-цвет;
 * его нельзя писать в атрибут, иначе глиф пропадает. Цвет берётся из `currentColor`,
 * а наведение и активное состояние красят `path` стилем меню.
 */
export const SITE_REFRESH_ICON_PATH =
  'M16 3a13 13 0 1 0 13 13A13.013 13.013 0 0 0 16 3m9.796 8h-4.428a17.8 17.8 0 0 0-2.533-5.625A11.05 11.05 0 0 1 25.796 11M16 5.014c1.5 1.625 2.625 3.693 3.296 5.986h-6.592C13.375 8.707 14.5 6.641 16 5.014M12 16c0-1.005.084-2.009.25-3h7.5a18.2 18.2 0 0 1 0 6h-7.5a18 18 0 0 1-.25-3m.704 5h6.592c-.671 2.293-1.796 4.359-3.296 5.986-1.5-1.627-2.625-3.693-3.296-5.986m6.131 5.625A17.8 17.8 0 0 0 21.367 21h4.43a11.05 11.05 0 0 1-6.962 5.625M21.776 19a20.2 20.2 0 0 0 0-6h4.808a11 11 0 0 1 0 6z';

export interface SiteRefreshIconProps {
  width?: number | string;
  height?: number | string;
  fill?: string;
}

export function siteRefreshIconProps({ width = 20, height = 20, fill, ...rest }: SiteRefreshIconProps = {}) {
  // `fill` из меню — имя цвета темы (`neutral500`), не CSS-цвет. Глиф красится через currentColor.
  void fill;
  return {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 32 32',
    width,
    height,
    fill: 'none',
    'aria-hidden': true as const,
    ...rest,
  };
}
