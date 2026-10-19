/**
 * Съём снимка идёт отдельным процессом по REST; публичная роль REST не открывает.
 * Ключ сохраняется в Strapi как API-токен, а значение передаётся worker только через
 * CMS_TOKEN. Обычный запуск не должен создавать такой ключ: bootstrap включает его
 * только для явно отмеченной частной репетиции.
 */
const CAPTURE_TOKEN_NAME = 'site-refresh-capture';

type TokenService = {
  getByName: (
    name: string,
    options?: { includeDecryptedKey?: boolean },
  ) => Promise<{ id?: number; type?: string; accessKey?: string } | null>;
  create: (attributes: {
    name: string;
    description: string;
    type: string;
    lifespan: null;
  }) => Promise<{ accessKey?: string }>;
};

export async function ensureCaptureToken(strapi: { service: (name: string) => TokenService }): Promise<void> {
  const tokens = strapi.service('admin::api-token');
  const existing = await tokens.getByName(CAPTURE_TOKEN_NAME, { includeDecryptedKey: true });
  const accessKey =
    existing?.type === 'read-only' && existing.accessKey
      ? existing.accessKey
      : (
          await tokens.create({
            name: CAPTURE_TOKEN_NAME,
            description: 'Чтение опубликованного контента для снимка сайта',
            type: 'read-only',
            lifespan: null,
          })
        ).accessKey;
  if (!accessKey) throw new Error('Токен съёма сайта не получен.');
  process.env.CMS_TOKEN = accessKey;
}

/** Provision the capture token only in an explicitly opted-in private rehearsal. */
export async function bootstrapCaptureTokenForRehearsal(
  strapi: { service: (name: string) => TokenService },
): Promise<void> {
  if (process.env.IKPK_ENABLE_CAPTURE_TOKEN_BOOTSTRAP !== '1') return;
  await ensureCaptureToken(strapi);
}
