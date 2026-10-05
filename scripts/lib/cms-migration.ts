/**
 * Перенос контента: контрольная точка предыдущего прогона, условная запись,
 * доведение частичной записи, ключ повторяемости медиа, карта панелей,
 * заключительная сверка и годность материала переноса.
 *
 * Подписи заданы `./cms-authoring-contract.ts` (выбраны сессией тестов).
 */

import { createHash } from 'node:crypto';
import type { DocumentsState, Migration, PanelMapEntry, RevisionStore } from './cms-authoring-contract';

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function checkpointVerdict({
  recordId,
  current,
  checkpoint,
}: {
  recordId: string;
  current?: string;
  checkpoint?: { recordId: string; revision: string };
}): { action: 'write' | 'stop'; message: string } {
  if (current === undefined) {
    return { action: 'write', message: `новая запись, пишем: ${recordId}` };
  }
  if (!checkpoint || checkpoint.revision !== current) {
    return {
      action: 'stop',
      message: `расхождение с контрольной точкой предыдущего прогона для ${recordId}: текущая ревизия изменилась между прогонами`,
    };
  }
  return { action: 'write', message: `ревизия совпадает с контрольной точкой: ${recordId}` };
}

function documentsStateFromSource({ hasDocumentsPanel }: { hasDocumentsPanel: boolean }): DocumentsState {
  // Отсутствие панели — пробел в исходном материале, а не подтверждённое
  // отсутствие документов (design.md, D2): толковать его как «не выдаются»
  // означало бы придумать факт, которого источник не сообщал.
  return hasDocumentsPanel ? 'issued' : 'unconfirmed';
}

function applyRecord({
  store,
  recordId,
  expectedRevision,
  value,
}: {
  store: RevisionStore;
  recordId: string;
  expectedRevision: string;
  value: unknown;
}): { applied: boolean; reason: string } {
  const applied = store.compareAndSet(recordId, expectedRevision, value);
  return {
    applied,
    reason: applied
      ? `ревизия совпала — запись ${recordId} применена`
      : `ревизия записи ${recordId} изменилась между сравнением и записью — правка редактора не затёрта`,
  };
}

function previousAddressCoverage({
  migrated,
}: {
  migrated: { id: string; previousAddresses: string[] }[];
}): { migratedCount: number; withPreviousAddress: number; ok: boolean; missing: string[] } {
  const missing = migrated.filter((m) => m.previousAddresses.length === 0).map((m) => m.id);
  return {
    migratedCount: migrated.length,
    withPreviousAddress: migrated.length - missing.length,
    ok: missing.length === 0,
    missing,
  };
}

function panelField({
  url,
  heading,
  map,
}: {
  url: string;
  heading: string;
  map: PanelMapEntry[];
}): { field: string } | { stop: true; message: string } {
  const entry = map.find((e) => e.url === url && e.heading === heading);
  if (!entry) {
    return {
      stop: true,
      message: `панель без соответствия в карте: адрес ${url}, заголовок «${heading}» — перенос остановлен`,
    };
  }
  return { field: entry.field };
}

function mediaKey(file: { bytes: Uint8Array; sourceUrl: string }): string {
  // Ключ по содержимому, а не по адресу источника: одно и то же содержимое под
  // разными адресами не должно удваивать медиатеку (design.md, D6).
  return createHash('sha256').update(file.bytes).digest('hex');
}

function resumeVerdict({
  recordId,
  cmsRecord,
  requiredRelations,
}: {
  recordId: string;
  cmsRecord: Record<string, unknown> | undefined;
  requiredRelations: string[];
}): { action: 'complete' | 'replace' | 'skip'; complete: boolean; message: string } {
  if (!cmsRecord) {
    return {
      action: 'replace',
      complete: false,
      message: `запись ${recordId} отсутствует в системе управления — перенос запишет её заново`,
    };
  }
  const missingRelations = requiredRelations.filter((relation) => isEmpty(cmsRecord[relation]));
  const complete = missingRelations.length === 0;
  return {
    action: 'complete',
    complete,
    message: complete
      ? `запись ${recordId} полна`
      : `запись ${recordId} перенесена частично: нет связей ${missingRelations.join(', ')} — перенос доведёт её`,
  };
}

function reconcile({
  source,
  cms,
  mediaReferences = [],
  cmsMedia = [],
}: {
  source: { type: string; ids: string[] }[];
  cms: { type: string; ids: string[] }[];
  mediaReferences?: { recordId: string; file: string }[];
  cmsMedia?: string[];
}): {
  ok: boolean;
  countMismatch: { type: string; source: number; cms: number }[];
  deletions: { type: string; id: string }[];
  mediaMissing: { recordId: string; file: string }[];
  message: string;
} {
  const bySourceType = new Map(source.map((s) => [s.type, s.ids]));
  const byCmsType = new Map(cms.map((c) => [c.type, c.ids]));
  const types = new Set([...bySourceType.keys(), ...byCmsType.keys()]);

  const countMismatch: { type: string; source: number; cms: number }[] = [];
  const deletions: { type: string; id: string }[] = [];

  for (const type of types) {
    const sourceIds = bySourceType.get(type) ?? [];
    const cmsIds = byCmsType.get(type) ?? [];
    if (sourceIds.length !== cmsIds.length) {
      countMismatch.push({ type, source: sourceIds.length, cms: cmsIds.length });
    }
    for (const id of cmsIds) {
      if (!sourceIds.includes(id)) deletions.push({ type, id });
    }
  }

  const mediaMissing = mediaReferences.filter((ref) => !cmsMedia.includes(ref.file));
  const ok = countMismatch.length === 0 && deletions.length === 0 && mediaMissing.length === 0;

  return {
    ok,
    countMismatch,
    deletions,
    mediaMissing,
    message: ok
      ? 'сверка пройдена: состав и медиа системы управления совпадают с материалом сверки'
      : 'сверка обнаружила расхождение — переключение источника остановлено',
  };
}

function acceptMaterial({
  method,
  mediaCoverage,
  revisionBefore,
  revisionAfter,
  revisionCoversMediaBytes,
}: {
  method: 'freeze' | 'atomic-dump' | 'crawl-with-revision';
  mediaCoverage?: 'freeze' | 'storage-snapshot' | 'proven-immutable' | 'byte-mark' | 'none';
  revisionBefore?: string;
  revisionAfter?: string;
  revisionCoversMediaBytes?: boolean;
}): { ok: boolean; message: string } {
  if (method === 'freeze') {
    return { ok: true, message: 'заморозка редактирования: перенос и сверка идут по неизменному состоянию' };
  }

  if (method === 'atomic-dump') {
    const coversMedia = mediaCoverage !== undefined && mediaCoverage !== 'none';
    return {
      ok: coversMedia,
      message: coversMedia
        ? 'атомарный дамп с доказанным покрытием медиа принят'
        : 'атомарный дамп таблиц не покрывает медиа: файловое хранилище в транзакцию не входит',
    };
  }

  // crawl-with-revision
  const stable = revisionBefore !== undefined && revisionBefore === revisionAfter;
  if (!stable) {
    return { ok: false, message: 'источник изменился во время обхода: отметка состояния разошлась на его концах' };
  }
  if (revisionCoversMediaBytes !== true) {
    return { ok: false, message: 'отметка состояния не меняется на изменение байтов медиа — покрытие не доказано' };
  }
  return { ok: true, message: 'обход принят: отметка состояния не изменилась и покрывает байты медиа' };
}

const migration: Migration = {
  checkpointVerdict,
  documentsStateFromSource,
  applyRecord,
  previousAddressCoverage,
  panelField,
  mediaKey,
  resumeVerdict,
  reconcile,
  acceptMaterial,
};

export default migration;
export {
  checkpointVerdict,
  documentsStateFromSource,
  applyRecord,
  previousAddressCoverage,
  panelField,
  mediaKey,
  resumeVerdict,
  reconcile,
  acceptMaterial,
};
