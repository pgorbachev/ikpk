/**
 * Fail-closed guard браузерных наборов оплаты (задача 6.15, пятый пункт).
 *
 * Требование: «любой неперехваченный запрос к stand API либо живой ЮKassa роняет тест;
 * секретов в CI нет» (`tasks.md`, 6.15; спека — Requirement «Роли `ci` и `preview` не
 * создают платежей…», где обращение к ЮKassa запрещено даже в тестовом контуре, потому что
 * любое из них создаёт настоящую, пусть тестовую, транзакцию).
 *
 * ДВА СЛОЯ, и они про разное — путать их нельзя:
 *
 *  1. блокировка разрешения имён в конфигурации набора
 *     (`--host-resolver-rules=MAP * ~NOTFOUND`) — ни один внешний ХОСТ не достижим
 *     физически: ни `yookassa.ru`, ни аналитика боевого артефакта. Слой не «ловит», а
 *     запрещает. Его границу надо знать: объявленная база стенда — литеральный IP
 *     `193.124.115.99`, разрешения имени у неё нет, и этот слой её не закрывает;
 *  2. этот перехват — закрывает литеральный IP (матч по origin, обрыв до сети) и НАЗЫВАЕТ
 *     предмет, роняя тест. Одного слоя 1 не хватило бы дважды: он пропускает IP и
 *     превращает утечку в безымянный сетевой сбой внутри продуктового кода, который читается
 *     как «что-то с сетью», а не как «проверка обратилась к живому контуру».
 *
 * ПОРЯДОК РЕГИСТРАЦИИ ВАЖЕН. Playwright применяет маршруты в обратном порядке
 * регистрации: последний зарегистрированный обработчик получает запрос первым. Поэтому
 * guard ставится ПЕРВЫМ — тогда моки конкретного теста, поставленные позже, забирают свои
 * запросы, а guard видит ровно то, что не забрал никто. Это и есть fail-closed: закрытым
 * оказывается пропуск мока, а не его наличие.
 *
 * ПЕРЕХВАТ ОГРАНИЧЕН ПЛАТЁЖНЫМИ АДРЕСАТАМИ, и это измерено, а не выбрано по вкусу. Артефакт
 * роли `stand` тянет живую аналитику (`mc.yandex.ru`, `top-fwz1.mail.ru`); попытка обрывать
 * ЛЮБОЙ внешний запрос растянула набор с 57 секунд до 18,2 минуты — обрыв запроса скрипта
 * страница переживает плохо. Аналитику берёт на себя слой 1: имя не разрешается, отказ
 * приходит сразу. Список `blocked` поэтому остаётся пустым и в предмет не входит.
 *
 * ГРАНИЦА «живой ЮKassa»: настоящие хосты (`yookassa.ru`, `yoomoney.ru` и их поддомены).
 * `yookassa.test` из существующих проверок — тестовый двойник, его document-навигацию
 * перехватывает `yookassa-navigation.ts`; считать двойник живым контуром было бы
 * подменой предмета.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ: не меняет ни `data-payment-role`, ни объявленную базу, ни
 * ответы продукта (задача 6.15, четвёртый пункт). Он только записывает и обрывает то, что
 * не перехвачено тестом.
 */

import { expect, type Page } from '@playwright/test';
import { PAYMENT_ENDPOINT_BASE } from './payment-contract';
import type { BrowserRole } from './payment-artifacts';

/** Настоящие хосты ЮKassa. Тестовый двойник `yookassa.test` сюда намеренно не попадает. */
const LIVE_YOOKASSA_HOST = /(^|\.)(yookassa|yoomoney)\.(ru|com)$/i;

export type EscapeSubject = 'объявленная база роли' | 'живая ЮKassa' | 'посторонний контур';

export type Escape = { subject: EscapeSubject; method: string; url: string };

export type FailClosedGuard = {
  role: BrowserRole;
  /** Origin объявленной базы своей роли: обращения сюда обязан перехватывать сам тест. */
  allowedApiOrigin: string;
  /** Origin-ы других контуров: обращение туда — подмена предмета, а не забытый мок. */
  foreignApiOrigins: string[];
  /** Утечки к предметам задачи 6.15: роняют тест. */
  escapes: Escape[];
  /**
   * Внешние адресаты, обо́рванные перехватом, но не входящие в предмет 6.15. Список остаётся
   * пустым, пока перехват ограничен платёжными адресатами (см. шапку): аналитику снимает слой
   * 1. Поле сохранено, чтобы расширение перехвата не пришлось делать молча.
   */
  blocked: string[];
};

/** Loopback: сам preview-сервер набора. Всё остальное — внешний адресат. */
function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function originOf(base: string): string {
  return new URL(base).origin;
}

/** Предмет, названный по URL. `null` — запрос не про платёжный контур (страница, ассеты). */
export function escapeSubject(
  url: string,
  guard: Pick<FailClosedGuard, 'allowedApiOrigin' | 'foreignApiOrigins'>,
): EscapeSubject | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (LIVE_YOOKASSA_HOST.test(parsed.hostname)) return 'живая ЮKassa';
  if (parsed.origin === guard.allowedApiOrigin) return 'объявленная база роли';
  if (guard.foreignApiOrigins.includes(parsed.origin)) return 'посторонний контур';
  return null;
}

/**
 * Поставить guard. Вызывать ПЕРВЫМ в `beforeEach` — до моков теста и до
 * `interceptYooKassaNavigation`.
 */
export async function installFailClosedGuard(page: Page, role: BrowserRole): Promise<FailClosedGuard> {
  const allowedApiOrigin = originOf(PAYMENT_ENDPOINT_BASE[role]);
  const foreignApiOrigins = (['preview', 'stand', 'prod'] as const)
    .map((r) => originOf(PAYMENT_ENDPOINT_BASE[r]))
    .filter((o) => o !== allowedApiOrigin);
  const guard: FailClosedGuard = { role, allowedApiOrigin, foreignApiOrigins, escapes: [], blocked: [] };

  await page.route(
    (url) => !isLoopback(url.hostname) && escapeSubject(url.toString(), guard) !== null,
    async (route) => {
      const request = route.request();
      const subject = escapeSubject(request.url(), guard);
      if (subject) guard.escapes.push({ subject, method: request.method(), url: request.url() });
      else guard.blocked.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
    },
  );

  return guard;
}

/**
 * Забрать и ОЧИСТИТЬ записанные утечки. Нужен ровно одной проверке — самопроверке
 * взведённости guard'а, которая утечки создаёт намеренно. Всем остальным нужен
 * `expectNoEscapes`.
 */
export function takeEscapes(guard: FailClosedGuard): Escape[] {
  return guard.escapes.splice(0, guard.escapes.length);
}

/**
 * Fail-closed постусловие теста. Пустой список значит «ни один запрос к платёжному контуру
 * не ушёл мимо перехвата», а не «проверять было нечего»: непустой список — отказ с
 * названным предметом, и он остаётся отказом, даже если сам тест зелёный.
 */
export function expectNoEscapes(guard: FailClosedGuard): void {
  const named = guard.escapes.map((e) => `${e.subject}: ${e.method} ${e.url}`);
  expect(
    named,
    `запрос ушёл мимо перехвата Playwright — набор роли ${guard.role} обращался к живому ` +
      `контуру, и его исход про поведение продукта ничего не говорит`,
  ).toEqual([]);
}
