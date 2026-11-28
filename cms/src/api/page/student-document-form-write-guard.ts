const FIELD = 'student_document_form_url';

type Event = { params: { data?: Record<string, unknown> } };
type StrapiLike = { db: { lifecycles: { subscribe(value: {
  models: string[]; beforeCreate(event: Event): void; beforeUpdate(event: Event): void;
}): void } } };

export function registerStudentDocumentFormWriteGuard(strapi: StrapiLike) {
  strapi.db.lifecycles.subscribe({
    models: ['api::page.page'],
    beforeCreate(event: Event) { if (event.params.data) delete event.params.data[FIELD]; },
    beforeUpdate(event: Event) { if (event.params.data) delete event.params.data[FIELD]; },
  });
}
