import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStrapi, type LiveStrapi } from '../helpers/live-strapi.ts';

/**
 * Редактируемость содержимого через тот же HTTP-шов, которым пользуется админка.
 *
 * Зачем отдельно от сверки схем: на поле `status` схема была безупречна — перечисление
 * объявлено, значения допустимы, снимок собирался, сайт работал, — а сохранить запись
 * было нельзя. Strapi 5 занимает это имя под статус документа, и поле оказывалось зажато
 * между двумя проверками: ни `active`, ни `draft` не проходили обе. Ни один статический
 * тест такого не видит, потому что расхождение возникает только при обращении к API.
 *
 * Поэтому здесь проверяется ПОВЕДЕНИЕ: запись создаётся и изменяется. Тест переживёт
 * любое переименование полей и поймает любое будущее столкновение имён, а не только те,
 * что кто-то вспомнил перечислить.
 */
describe('содержимое редактируется через content-manager API', () => {
  let cms: LiveStrapi;

  beforeAll(async () => {
    cms = await startStrapi();
  }, 200_000);

  afterAll(() => cms?.stop());

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${cms.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cms.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });

  it('запись расписания создаётся со своим статусом', async () => {
    const res = await call('/content-manager/collection-types/api::schedule-entry.schedule-entry', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Проверка редактируемости',
        entry_status: 'active',
        startAt: '2026-12-01T09:00:00.000Z',
      }),
    });
    const body = (await res.json()) as { data?: Record<string, unknown>; error?: { message?: string } };
    // Сообщение об отказе попадает в вывод: «400» само по себе не говорит, что сломано.
    expect(res.ok, `создание отклонено: ${body.error?.message ?? res.status}`).toBe(true);
    expect(body.data?.entry_status).toBe('active');
  }, 90_000);

  // Второй срез: правка СУЩЕСТВУЮЩЕЙ записи. Создание и изменение — разные пути в
  // Strapi (POST против PUT по documentId), и на `status` отказывали оба, но убедиться
  // в этом можно только дёрнув каждый.
  it('существующий семинар сохраняется после правки', async () => {
    const created = await call('/content-manager/collection-types/api::seminar.seminar', {
      method: 'POST',
      body: JSON.stringify({ name: 'Семинар для правки', slug: 'seminar-dlya-pravki' }),
    });
    const made = (await created.json()) as { data?: { documentId?: string }; error?: { message?: string } };
    expect(created.ok, `создание семинара отклонено: ${made.error?.message ?? created.status}`).toBe(true);
    const id = made.data?.documentId;
    expect(id, 'создание не вернуло documentId — править нечего').toBeTruthy();

    const res = await call(`/content-manager/collection-types/api::seminar.seminar/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ seminar_status: 'planned', duration: '3 дня' }),
    });
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      error?: { message?: string };
    };
    expect(res.ok, `правка отклонена: ${body.error?.message ?? res.status}`).toBe(true);
    expect(body.data?.seminar_status).toBe('planned');
    // Соседнее поле тоже доехало: иначе «сохранилось» означало бы лишь «запрос принят».
    expect(body.data?.duration).toBe('3 дня');
  }, 90_000);
});
