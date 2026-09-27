/**
 * Съём снимка идёт отдельным процессом по REST. Публичная роль этот REST не открывает:
 * на демо `institutes` отвечает 403, и кнопка останавливается на фазе capture.
 * Токен только на чтение создаётся здесь и живёт в памяти процесса; в состояние и логи
 * он не пишется (worker передаёт его заголовком, а redact вычищает строку CMS_TOKEN).
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
