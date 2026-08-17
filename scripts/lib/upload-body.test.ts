import { describe, it, expect } from 'vitest';
import { buildUploadBody } from './upload-body.js';

// Дефект B11 (docs/security-audit-2026-08-08.md): имя файла бралось из URL данных
// скрейпа, после decodeURIComponent могло содержать `"`, CR и LF, и подставлялось
// в заголовок Content-Disposition дословно. CRLF позволяет дописать свои части
// multipart-тела к запросу, который уходит в Strapi с полноправным токеном.

/** Блок заголовков части — всё до первой пустой строки. */
function headerBlock(body: Buffer): string {
  return body.toString('latin1').split('\r\n\r\n')[0];
}

/** Строки заголовков после строки boundary. */
function headerLines(body: Buffer): string[] {
  return headerBlock(body).split('\r\n').slice(1);
}

describe('buildUploadBody — честное имя', () => {
  it('обычное имя попадает в filename', () => {
    const { body } = buildUploadBody(Buffer.from('x'), 'photo.webp', 'image/webp');
    expect(headerBlock(body)).toContain('photo.webp');
  });

  // Кириллица в именах у заказчика реальна. Это СТРАЖ, а не воспроизведение дефекта:
  // он обязан быть зелёным и до фикса, и после — наивная очистка вида `[^\w.-]→_`
  // уничтожила бы такие имена, и тест это поймает.
  it('кириллическое имя не теряется', () => {
    const { body } = buildUploadBody(Buffer.from('x'), 'схема-1.webp', 'image/webp');
    // Заголовок читаем как UTF-8: сырые байты кириллицы в latin1 превращаются
    // в мохендзи, и проверка мерила бы кодировку, а не сохранность имени.
    const block = body.toString('utf-8').split('\r\n\r\n')[0];
    const survives = block.includes('схема-1') || block.includes(encodeURIComponent('схема-1'));
    expect(survives, `кириллица уничтожена: ${block}`).toBe(true);
  });
});

describe('buildUploadBody — враждебное имя не ломает заголовки', () => {
  it('перевод строки в имени не создаёт новых заголовков', () => {
    const evil = 'a\r\nX-Injected: 1\r\n\r\nevil.png';
    const { body } = buildUploadBody(Buffer.from('x'), evil, 'image/png');
    const lines = headerLines(body);
    expect(
      lines.some((l) => /^X-Injected:/i.test(l)),
      `инъекция заголовка прошла:\n${headerBlock(body)}`,
    ).toBe(false);
    // Ровно два заголовка части: Content-Disposition и Content-Type.
    expect(lines).toHaveLength(2);
  });

  it('кавычка в имени не выходит из значения filename', () => {
    const evil = 'a"; name="files"; filename="pwned.png';
    const { body } = buildUploadBody(Buffer.from('x'), evil, 'image/png');
    const cd = headerLines(body).find((l) => l.startsWith('Content-Disposition:')) ?? '';
    // В корректном заголовке ровно четыре кавычки: вокруг name и вокруг filename.
    expect((cd.match(/"/g) ?? []).length, `кавычки не экранированы: ${cd}`).toBe(4);
  });

  // `form-data` экранирует ИМЯ, но не тип: значение приходит из заголовка чужого
  // сервера, поэтому закрываем тот же класс и со стороны типа.
  it('враждебный content-type не попадает в заголовок дословно', () => {
    const { body } = buildUploadBody(
      Buffer.from('x'),
      'photo.webp',
      'image/png\r\nX-Injected: 1',
    );
    const lines = headerLines(body);
    expect(
      lines.some((l) => /^X-Injected:/i.test(l)),
      `инъекция через content-type прошла:\n${headerBlock(body)}`,
    ).toBe(false);
    expect(lines).toHaveLength(2);
  });

  it('обычный content-type сохраняется, параметры отбрасываются', () => {
    const { body } = buildUploadBody(Buffer.from('x'), 'a.webp', 'image/webp; charset=utf-8');
    expect(headerBlock(body)).toContain('Content-Type: image/webp');
  });

  it('тело запроса не содержит лишней границы, собранной из имени', () => {
    const { body, contentType } = buildUploadBody(
      Buffer.from('x'),
      'a\r\n--boundary--\r\n.png',
      'image/png',
    );
    const boundary = contentType.split('boundary=')[1];
    const occurrences = body.toString('latin1').split(`--${boundary}`).length - 1;
    // Открывающая и закрывающая — ровно две.
    expect(occurrences).toBe(2);
  });

  it('required-check negative proof', () => {
    expect(true).toBe(false);
  });
});
