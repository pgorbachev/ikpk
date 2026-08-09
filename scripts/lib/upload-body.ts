import FormData from 'form-data';

/**
 * Тело multipart-запроса для загрузки файла в Strapi. Вынесено из import.ts:
 * сам скрипт безусловно зовёт main(), поэтому проверить сборку заголовков
 * изолированно было нельзя.
 */
export interface UploadBody {
  body: Buffer;
  contentType: string;
}

/**
 * MIME-тип, пригодный для подстановки в заголовок.
 *
 * `form-data` экранирует только имя файла, а `contentType` подставляет дословно —
 * то есть остаточная поверхность того же класса, что закрывал фикс имени. Значение
 * приходит из заголовка чужого сервера. Сегодня CRLF туда не пролезет (HTTP-клиент
 * не отдаёт заголовки с сырыми переводами строк), поэтому это не живой дефект, а
 * закрытие класса: берём только то, что похоже на MIME, иначе безопасный дефолт.
 */
function safeMime(mime: string): string {
  const value = mime.split(';')[0].trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value
    : 'application/octet-stream';
}

export function buildUploadBody(buf: Buffer, filename: string, mime: string): UploadBody {
  // Заголовок собирает form-data, а не конкатенация строк: имя приходит из URL
  // данных скрейпа и после decodeURIComponent может содержать `"`, CR и LF.
  // Вручную собранный Content-Disposition такое имя принимал дословно — кавычка
  // выходила из значения, а CRLF дописывал свои части к запросу, который уходит
  // в Strapi с полноправным токеном. form-data percent-encode'ит эти символы
  // (проверено на установленной версии) и при этом не уничтожает кириллицу,
  // в отличие от наивной очистки вида `[^\w.-]` → `_`.
  const form = new FormData();
  form.append('files', buf, { filename, contentType: safeMime(mime) });
  return {
    body: form.getBuffer(),
    contentType: `multipart/form-data; boundary=${form.getBoundary()}`,
  };
}
