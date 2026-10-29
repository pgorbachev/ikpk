export type TeacherRelationsStatus = 'loading' | 'ready' | 'error';

const statusByDocument = new Map<string, TeacherRelationsStatus>();
const listenersByDocument = new Map<string, Set<() => void>>();

export function getTeacherRelationsStatus(documentId: string): TeacherRelationsStatus | undefined {
  return statusByDocument.get(documentId);
}

export function setTeacherRelationsStatus(documentId: string, status: TeacherRelationsStatus): void {
  if (!documentId || statusByDocument.get(documentId) === status) return;
  statusByDocument.set(documentId, status);
  listenersByDocument.get(documentId)?.forEach((listener) => listener());
}

export function invalidateTeacherRelationsStatus(documentId: string): void {
  if (!documentId || !statusByDocument.delete(documentId)) return;
  listenersByDocument.get(documentId)?.forEach((listener) => listener());
}

export function subscribeTeacherRelationsStatus(documentId: string, listener: () => void): () => void {
  if (!documentId) return () => {};
  const listeners = listenersByDocument.get(documentId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByDocument.set(documentId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByDocument.delete(documentId);
  };
}
