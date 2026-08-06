// Ссылки на формы заявки (CRM-формы облачного Bitrix24 заказчика).
//
// ЗАЧЕМ ЭТОТ СЛОЙ: на демо/превью-стенде кнопка «Записаться» не должна писать
// в ПРОДАКШЕН-CRM заказчика — иначе каждый клик на показе создаёт живой лид.
// Режим задаётся переменной окружения на сборке:
//
//   DEMO_FORMS=stub          → все формы ведут на локальную страницу-заглушку
//                              /demo-zayavka/ (noindex), которая объясняет,
//                              что это демо-стенд
//   DEMO_FORMS=<host>        → хост формы подменяется на указанный
//                              (например, свой тестовый портал Bitrix24:
//                              DEMO_FORMS=b24-test123.bitrix24site.ru)
//   не задана (прод)         → реальные ссылки заказчика, как есть
//
// Прод-сборка (`npm run build`) переменную не задаёт, поэтому поведение по
// умолчанию — настоящие формы.

const PROD_FORM_HOST = 'b24-cbqwqo.bitrix24site.ru';
// без завершающего слэша: сайт адресует страницы как старый (см. trailingSlash)
const DEMO_STUB_PATH = '/demo-zayavka';

const mode = (import.meta.env.DEMO_FORMS ?? '').trim();

/** Режим демо-форм активен (нужно для баннера на стенде и для гейтов). */
export const isDemoForms = mode.length > 0;

/**
 * Ссылка на форму заявки с учётом режима сборки.
 * Пустое значение на входе отдаём как есть — вызывающий код сам решает
 * (обычно ведёт на /raspisanie-i-tseny).
 */
export function registrationHref(url: string | undefined | null): string {
  if (!url) return '';
  if (!isDemoForms) return url;
  if (mode === 'stub') return DEMO_STUB_PATH;
  // подмена хоста: свой тестовый портал Bitrix24
  try {
    const parsed = new URL(url);
    parsed.hostname = mode;
    return parsed.href;
  } catch {
    return DEMO_STUB_PATH;
  }
}

/** Нужен ли внешний target/rel для этой ссылки (у заглушки — нет). */
export function isExternalFormHref(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export { PROD_FORM_HOST, DEMO_STUB_PATH };
