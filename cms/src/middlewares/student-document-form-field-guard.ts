const FIELD = 'student_document_form_url';
const METHODS = new Set(['POST', 'PUT', 'PATCH']);
type Context = { path?: string; method: string; request?: { body?: unknown }; throw(status: number, message: string): never };
type Middleware = (ctx: Context, next: () => Promise<unknown>) => Promise<unknown>;

function isDirectPageWrite(ctx: Context): boolean {
  let path = ctx.path ?? '';
  try { path = decodeURIComponent(path); } catch { /* malformed paths will not match */ }
  return /(?:^|\/)api\/pages(?:\/|$)/.test(path)
    || /(?:^|\/)content-manager\/collection-types\/api::page\.page(?:\/|$)/.test(path);
}

export function studentDocumentFormFieldGuard(): Middleware {
  return async (ctx, next) => {
  if (METHODS.has(ctx.method) && isDirectPageWrite(ctx)) {
    const body = ctx.request?.body as Record<string, unknown> | undefined;
    const record = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const nested = record?.data;
    const nestedRecord = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : null;
    if ((record && Object.prototype.hasOwnProperty.call(record, FIELD))
      || (nestedRecord && Object.prototype.hasOwnProperty.call(nestedRecord, FIELD))) {
      ctx.throw(400, `Поле ${FIELD} редактируется только на странице «Страницы → Оплата».`);
    }
  }
    return next();
  };
}

export default () => studentDocumentFormFieldGuard();
