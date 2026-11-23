const PLACEHOLDER_SLUG = /^course-group(?:-\d+)?$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Подпись в списке выбора: институт слева, чтобы одинаковые названия программ различались. */
export function programEditorLabel(instituteName: unknown, programName: unknown): string {
  const institute = text(instituteName);
  const program = text(programName);
  if (institute && program) return `${institute} — ${program}`;
  return program || institute;
}

export type ProgramSlugDecision =
  | { action: 'clear' }
  | { action: 'keep' | 'incoming' | 'generate'; slug?: string };

/**
 * Новый адрес считается из названия.
 * Заглушка `course-group`, которую форма записывает до ввода названия, заменяется.
 * Явный адрес при создании сохраняется: его присылают перенос и тесты.
 * Уже сохранённый адрес при правке не меняется.
 */
export function decideProgramSlug({
  name,
  existingSlug,
  existingName,
  incomingSlug,
  trustedImport,
  isCreate,
}: {
  name: unknown;
  existingSlug: unknown;
  existingName: unknown;
  incomingSlug: unknown;
  trustedImport: boolean;
  isCreate: boolean;
}): ProgramSlugDecision {
  const trimmed = text(name);
  const slug = text(existingSlug);
  const incoming = text(incomingSlug);
  if (trustedImport && isCreate && incoming) return { action: 'incoming', slug: incoming };
  if (!isCreate) {
    if (!trimmed) return slug ? { action: 'keep', slug } : { action: 'clear' };
    if (!slug) return { action: 'generate' };
    if (!text(existingName) && PLACEHOLDER_SLUG.test(slug)) return { action: 'generate' };
    return { action: 'keep', slug };
  }
  if (!trimmed) return { action: 'clear' };
  if (incoming && !PLACEHOLDER_SLUG.test(incoming)) return { action: 'incoming', slug: incoming };
  return { action: 'generate' };
}

type RelationTarget =
  | { unchanged: true }
  | { cleared: true }
  | { documentId: string }
  | { id: number };

/** Куда указывает связь в теле document service: не менялась, снята или указывает на запись. */
export function relationTarget(relation: unknown): RelationTarget {
  if (relation == null || typeof relation === 'boolean') return { unchanged: true };
  if (typeof relation === 'number') return { id: relation };
  if (typeof relation === 'string' && relation !== '') return { documentId: relation };
  if (typeof relation !== 'object') return { unchanged: true };
  const value = relation as {
    id?: unknown;
    documentId?: unknown;
    set?: unknown;
    connect?: unknown;
    disconnect?: unknown;
  };
  const list = Array.isArray(value.set) ? value.set : Array.isArray(value.connect) ? value.connect : null;
  if (list) {
    if (list.length === 0) return { cleared: true };
    const item = list[list.length - 1] as { id?: unknown; documentId?: unknown } | string | number;
    if (typeof item === 'number') return { id: item };
    if (typeof item === 'string' && item !== '') return { documentId: item };
    if (item && typeof item === 'object') {
      if (typeof item.documentId === 'string' && item.documentId !== '') return { documentId: item.documentId };
      if (typeof item.id === 'number') return { id: item.id };
    }
  }
  if (Array.isArray(value.disconnect) && value.disconnect.length > 0) return { cleared: true };
  if (typeof value.documentId === 'string' && value.documentId !== '') return { documentId: value.documentId };
  if (typeof value.id === 'number') return { id: value.id };
  return { unchanged: true };
}
