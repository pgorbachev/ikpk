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

export function buildUploadBody(buf: Buffer, filename: string, mime: string): UploadBody {
  // Заголовок собирает form-data, а не конкатенация строк: имя приходит из URL
  // данных скрейпа и после decodeURIComponent может содержать `"`, CR и LF.
  // Вручную собранный Content-Disposition такое имя принимал дословно — кавычка
  // выходила из значения, а CRLF дописывал свои части к запросу, который уходит
  // в Strapi с полноправным токеном. form-data percent-encode'ит эти символы
  // (проверено на установленной версии) и при этом не уничтожает кириллицу,
  // в отличие от наивной очистки вида `[^\w.-]` → `_`.
  const form = new FormData();
  form.append('files', buf, { filename, contentType: mime });
  return {
    body: form.getBuffer(),
    contentType: `multipart/form-data; boundary=${form.getBoundary()}`,
  };
}
