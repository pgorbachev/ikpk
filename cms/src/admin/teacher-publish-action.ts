import { useEffect, useSyncExternalStore } from 'react';
import type { BulkActionComponent, DocumentActionComponent } from '@strapi/content-manager/strapi-admin';
import { getTeacherRelationsStatus, subscribeTeacherRelationsStatus } from './teacher-relations-state';

const SCHEDULE_ENTRY_MODEL = 'api::schedule-entry.schedule-entry';

export function shouldGuardTeacherPublication(databaseClient: unknown): boolean {
  return databaseClient !== 'postgres' && databaseClient !== 'mysql';
}

function runtimeRequiresTeacherGuard(): boolean {
  const strapiWindow = window as Window & { strapi?: { flags?: Record<string, unknown> } };
  return shouldGuardTeacherPublication(strapiWindow.strapi?.flags?.ikpkDatabaseClient);
}

export function guardPublishDescription<T extends {
  disabled?: boolean;
  onClick?: (event: unknown) => unknown;
  dialog?: { type: string; onConfirm?: () => unknown; [key: string]: unknown };
}>(description: T, documentId: string, getStatus: (id: string) => string | undefined): T {
  const originalDialog = description.dialog;
  const dialog = originalDialog?.type === 'dialog' && originalDialog.onConfirm
    ? {
        ...originalDialog,
        onConfirm: () => {
          if (getStatus(documentId) !== 'ready') return;
          return originalDialog.onConfirm?.();
        },
      }
    : originalDialog;
  return {
    ...description,
    disabled: description.disabled || getStatus(documentId) !== 'ready',
    onClick: (event: unknown) => {
      if (getStatus(documentId) !== 'ready') return true;
      return description.onClick?.(event);
    },
    dialog,
  } as T;
}

export function guardScheduleEntryPublish(action: DocumentActionComponent): DocumentActionComponent {
  const guarded: DocumentActionComponent = (props) => {
    const documentId = props.documentId ?? props.document?.documentId;
    const isScheduleEntry = props.model === SCHEDULE_ENTRY_MODEL;
    const guardEnabled = runtimeRequiresTeacherGuard();
    useSyncExternalStore(
      (listener) => guardEnabled && documentId ? subscribeTeacherRelationsStatus(documentId, listener) : () => {},
      () => guardEnabled && documentId ? getTeacherRelationsStatus(documentId) : undefined,
      () => undefined,
    );
    useEffect(() => {
      if (!guardEnabled || !isScheduleEntry || !documentId) return undefined;
      const guardPublishShortcut = (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'enter') return;
        if (getTeacherRelationsStatus(documentId) === 'ready') return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener('keydown', guardPublishShortcut, true);
      return () => window.removeEventListener('keydown', guardPublishShortcut, true);
    }, [documentId, isScheduleEntry, guardEnabled]);
    const description = action(props);

    if (!guardEnabled || !isScheduleEntry || !documentId) return description;

    return guardPublishDescription(description, documentId, getTeacherRelationsStatus);
  };

  guarded.type = action.type;
  guarded.position = action.position;
  return guarded;
}

export function guardScheduleEntryBulkPublish(action: BulkActionComponent): BulkActionComponent {
  const guarded: BulkActionComponent = (props) => {
    const description = action(props);
    if (!runtimeRequiresTeacherGuard() || props.model !== SCHEDULE_ENTRY_MODEL || description?.actionType !== 'publish') return description;
    return { ...description, disabled: true, onClick: () => true };
  };
  return guarded;
}
