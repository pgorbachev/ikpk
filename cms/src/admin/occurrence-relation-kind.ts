const ENTRY = 'api::schedule-entry.schedule-entry';
const SEMINAR = 'api::seminar.seminar';

export type OccurrenceRelationKind = 'seminar' | 'teachers' | 'native';

/**
 * В модальном окне «создать связь» адрес страницы остаётся адресом семинара.
 * Модель формы берётся из её схемы, а не из адреса.
 */
export function occurrenceFormModel(urlModel: string, schemaUid?: string | null): string {
  return schemaUid || urlModel;
}

/** Семинар, из которого открыто новое проведение: его нельзя сменить. */
export function lockedSeminarId({
  urlModel,
  urlId,
  fromSeminar,
  entryDocumentId,
}: {
  urlModel: string;
  urlId?: string | null;
  fromSeminar?: string | null;
  entryDocumentId?: string | null;
}): string | null {
  if (fromSeminar) return fromSeminar;
  if (!entryDocumentId && urlModel === SEMINAR && urlId && urlId !== 'create') return urlId;
  return null;
}

/** Идентификатор проведения. Идентификатор семинара из адреса сюда не подходит. */
export function occurrenceEntryId(
  urlModel: string,
  urlId: string | null | undefined,
  entryDocumentId?: string | null,
): string | undefined {
  if (entryDocumentId) return entryDocumentId;
  if (urlModel === ENTRY && urlId && urlId !== 'create') return urlId;
  return undefined;
}

/** Список проведений внутри семинара остаётся штатным полем связи Strapi. */
export function occurrenceRelationKind(model: string, field: string): OccurrenceRelationKind {
  if (model === ENTRY && field === 'seminar') return 'seminar';
  if (model === ENTRY && field === 'teachers') return 'teachers';
  return 'native';
}
