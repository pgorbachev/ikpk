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

const mode = String((import.meta as ImportMeta & { env?: { DEMO_FORMS?: unknown } }).env?.DEMO_FORMS ?? '').trim();

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

/** Демонстрационный (mock) адрес — не боевой и не ЮKassa; закреплён за ролью `preview`. */
export const PAYMENT_ENDPOINT_DEMO = 'https://demo-api.ikpk.invalid';
/** База стенда: `<origin стенда>/api` (design.md, Решение 13). */
export const PAYMENT_ENDPOINT_STAND = 'http://193.124.115.99/api';

// ── Роль клиентской сборки (задачи 5.10, 5.10a) ──────────────────────────────
//
// НЕ ТО ЖЕ, ЧТО DEMO_FORMS выше: та переменная — режим форм ЗАЯВКИ (CRM Bitrix24), эта —
// роль платёжного контура. Совпадение имён не предполагается (design.md, Решение 13:
// «Роль сборки и режим сервиса SHALL оставаться разными значениями»), и одно не должно
// выводиться из другого — иначе стенд с настоящим тестовым магазином и preview с
// mock-формой снова стали бы невыразимы одним признаком.
export const PAYMENT_ROLES = ['ci', 'preview', 'stand', 'prod'] as const;
export type PaymentRole = (typeof PAYMENT_ROLES)[number];

/**
 * Роль сборки: `PAYMENT_ROLE` окружения сборки. Пустое/незаданное значение — безопасная
 * CI-сборка (`ci`), а не умолчание в сторону установленного контура. Неизвестное значение
 * останавливает сборку: молчаливое приведение опечатки к `ci` дало бы артефакт без формы
 * там, где заказан стенд, и расхождение всплыло бы только у посетителя.
 */
export function paymentRole(): PaymentRole {
  // Читается из обоих источников: реальная сборка Astro прокидывает произвольные
  // переменные окружения в `import.meta.env` (проверено на уже собранном `dist-demo`:
  // `DEMO_FORMS` тем же путём доходит до объявленного адреса), а `vitest` (`vi.stubEnv`)
  // при юнит-тестировании этого модуля напрямую пишет только `process.env` — под чистым
  // vitest, без плагина Astro, `import.meta.env` его не видит вовсе (проверено отдельно).
  const fromMeta = (import.meta as ImportMeta & { env?: { PAYMENT_ROLE?: unknown } }).env?.PAYMENT_ROLE;
  const raw = String(fromMeta ?? process.env.PAYMENT_ROLE ?? '').trim();
  if (raw === '') return 'ci';
  if ((PAYMENT_ROLES as readonly string[]).includes(raw)) return raw as PaymentRole;
  throw new Error(
    `неизвестная роль сборки PAYMENT_ROLE=${JSON.stringify(raw)}; допустимо: ${PAYMENT_ROLES.join('|')}`,
  );
}

/**
 * Объявляемая база платёжного эндпоинта. `ci` не объявляет базы вовсе (формы у неё нет по
 * контракту роли), `preview` — mock, `stand`/`prod` — база своего установленного контура.
 * Клиент дописывает `/payments` сам: значение, уже содержащее путь запроса, отправило бы
 * создание платежа на `/api/payments/payments`.
 */
export function paymentEndpoint(): string | null {
  const role = paymentRole();
  if (role === 'ci') return null;
  if (role === 'preview') {
    const custom = (import.meta.env.PAYMENT_ENDPOINT_DEMO ?? '').trim();
    return custom || PAYMENT_ENDPOINT_DEMO;
  }
  if (role === 'stand') {
    // Симметрично с preview/prod (независимое ревью, находка F-6, 2026-08-20): без
    // этого override `scripts/deploy-web.sh`'s `${PAYMENT_ENDPOINT_STAND:-...}` двигал бы
    // ожидание гейта, а сборка продолжала бы эмитировать константу — гейт после
    // корректно заданного `PAYMENT_ENDPOINT_STAND` гарантированно падал бы.
    const custom = (import.meta.env.PAYMENT_ENDPOINT_STAND ?? '').trim();
    return custom || PAYMENT_ENDPOINT_STAND;
  }
  // Роль `prod` NOT NULL умолчания не имеет (решение владельца 2026-08-20/21):
  // production endpoint этим change не выбран (`proposal.md`, Развилка 1, не принята) —
  // раньше здесь был захардкоженный `https://api.ikpk.su`, из-за чего production-сборка
  // публиковала форму на несуществующий адрес молча. Дочитывается из `process.env` тем же
  // способом, что и `paymentRole()` (см. её комментарий): реальная сборка Astro прокидывает
  // переменную в `import.meta.env`, а vitest без плагина Astro — только в `process.env`.
  const fromMeta = (import.meta as ImportMeta & { env?: { PAYMENT_ENDPOINT_PROD?: unknown } }).env
    ?.PAYMENT_ENDPOINT_PROD;
  const custom = String(fromMeta ?? process.env.PAYMENT_ENDPOINT_PROD ?? '').trim();
  if (!custom) {
    throw new Error(
      'роль сборки prod требует явно заданный PAYMENT_ENDPOINT_PROD — умолчания нет ' +
        '(production endpoint не выбран этим change, см. proposal.md, «Развилка 1», ' +
        'и tasks.md, «Future work», production-payment-rollout)',
    );
  }
  return custom;
}

export { PROD_FORM_HOST, DEMO_STUB_PATH };
