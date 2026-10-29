import { useEffect, useSyncExternalStore } from 'react';
import type { DocumentActionComponent } from '@strapi/content-manager/strapi-admin';
import { getTeacherRelationsStatus, subscribeTeacherRelationsStatus } from './teacher-relations-state';

const SCHEDULE_ENTRY_MODEL = 'api::schedule-entry.schedule-entry';

export function guardScheduleEntryPublish(action: DocumentActionComponent): DocumentActionComponent {
  const guarded: DocumentActionComponent = (props) => {
    const documentId = props.documentId ?? props.document?.documentId;
    const isScheduleEntry = props.model === SCHEDULE_ENTRY_MODEL;
    const status = useSyncExternalStore(
      (listener) => documentId ? subscribeTeacherRelationsStatus(documentId, listener) : () => {},
      () => documentId ? getTeacherRelationsStatus(documentId) : undefined,
      () => undefined,
    );
    useEffect(() => {
      if (!isScheduleEntry || !documentId) return undefined;
      const guardPublishShortcut = (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'enter') return;
        if (getTeacherRelationsStatus(documentId) === 'ready') return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('keydown', guardPublishShortcut, true);
      return () => window.removeEventListener('keydown', guardPublishShortcut, true);
    }, [documentId, isScheduleEntry]);
    const description = action(props);

    if (!isScheduleEntry || !documentId) return description;

    return {
      ...description,
      disabled: description.disabled || status !== 'ready',
      onClick: (event) => {
        if (getTeacherRelationsStatus(documentId) !== 'ready') return false;
        return description.onClick?.(event);
      },
    };
  };

  guarded.type = action.type;
  guarded.position = action.position;
  return guarded;
}
