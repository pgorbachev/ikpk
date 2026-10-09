// Публичная оферта на платные образовательные услуги.
//
// Две копии одного документа: в разделе «Документы» печать снята (так просил
// заказчик — файл для ознакомления), а ссылка из галочки ведёт на экземпляр
// с печатью. Галочка формы оплаты живёт в PaymentForm.astro и ссылается на
// вторую константу. Форма заявки — CRM Bitrix24, её поля этим репозиторием
// не задаются.

export const PUBLIC_OFFER_HREF = '/documents/publichnaya-oferta.pdf';
export const PUBLIC_OFFER_STAMPED_HREF = '/documents/publichnaya-oferta-s-pechatyu.pdf';

export const PUBLIC_OFFER_LABEL =
  'Публичная оферта на заключение договора об оказании платных образовательных услуг';

const SVEDENIYA_PATH = '/svedeniya-ob-obrazovatelnoy-organizatsii';
const DOCUMENTS_PANEL = 'Уставные документы';

/**
 * Дописывает ссылку на оферту без печати в панель, которую подвал называет
 * «Документы» (третья секция страницы сведений). Снимок контента при этом не
 * правится: следующая выгрузка с боевого сайта панель перезапишет, а ссылка
 * останется.
 */
export function withPublicOfferDocument<T extends Record<string, string>>(
  path: string | undefined,
  panels: T | undefined,
): T | undefined {
  if (!panels) return panels;
  const key = (path ?? '').replace(/\/+$/, '') || '/';
  if (key !== SVEDENIYA_PATH) return panels;
  const html = panels[DOCUMENTS_PANEL];
  if (!html || html.includes(PUBLIC_OFFER_HREF)) return panels;
  const item =
    `<li><a href="${PUBLIC_OFFER_HREF}" target="_blank" rel="noopener noreferrer">${PUBLIC_OFFER_LABEL}</a></li>`;
  const next = html.includes('</ul>')
    ? html.replace('</ul>', `${item}</ul>`)
    : `${html}<ul>${item}</ul>`;
  return { ...panels, [DOCUMENTS_PANEL]: next };
}
