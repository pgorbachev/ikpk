/**
 * Плоские адреса записей системы управления: грамматика идентификатора, области
 * уникальности по каталогам, история адресов и перенаправления из неё.
 *
 * Реализация подписей задана `./cms-authoring-contract.ts` (выбрана сессией тестов).
 */

import type { AddressState, ContentAddress, RecordRef, RecordType, Verdict } from './cms-authoring-contract';
import { CATALOG_BY_TYPE } from './cms-authoring-contract';

const IDENTIFIER_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidIdentifier(identifier: string): boolean {
  return IDENTIFIER_PATTERN.test(identifier);
}

export function addressOf(record: { type: RecordType; identifier: string }): string {
  if (record.type === 'static-page') return `/${record.identifier}`;
  return `${CATALOG_BY_TYPE[record.type]}/${record.identifier}`;
}

export function checkIdentifier({ record, state }: { record: RecordRef; state: AddressState }): Verdict {
  const { identifier, type, id } = record;

  if (!isValidIdentifier(identifier)) {
    return { ok: false, message: `недопустимый идентификатор: ${identifier}` };
  }

  const address = addressOf({ type, identifier });

  if (type === 'static-page' && state.buildRouteSegments.includes(identifier)) {
    const own = record.previousAddresses ?? [];
    if (!own.includes(address)) {
      return {
        ok: false,
        message: `сегмент маршрута сборки уже занят: ${identifier}`,
      };
    }
  }

  // Симметрично предыдущей проверке (ревью PR #186, дельта, находка F2): институт живёт
  // СЕЙЧАС по голому корневому адресу `/<identifier>` — том же, что вычисляет `addressOf`
  // для статической страницы, хотя ВЫЧИСЛЕННЫЙ адрес института другой (`/instituty/<id>`,
  // будущий плоский). Без этой проверки институт с чужим уже занятым корневым сегментом
  // проходил бы (адреса не совпадают вычислением) и на сборке `web` столкнулся бы с
  // `[slug].astro`, породившим страницу по тому же самому идентификатору. Проверка — только
  // в эту сторону: у прочих типов (программа, семинар, персона) иерархический адрес не
  // корневой сегмент, коллизии со статической страницей не даёт.
  if (type === 'institute') {
    const staticPageOwner = state.records.find((r) => r.type === 'static-page' && r.identifier === identifier);
    if (staticPageOwner && staticPageOwner.id !== id) {
      return {
        ok: false,
        message: `корневой сегмент уже занят статической страницей: ${identifier}`,
        conflictWith: staticPageOwner.id,
      };
    }
  }

  for (const entry of state.addressHistory) {
    if (entry.address === address && entry.ownerId !== id) {
      return {
        ok: false,
        message: `адрес занят историей записи ${entry.ownerId}`,
        conflictWith: entry.ownerId,
      };
    }
  }

  for (const other of state.records) {
    if (other.id === id) continue;
    if (addressOf({ type: other.type, identifier: other.identifier }) === address) {
      return {
        ok: false,
        message: `адрес уже занят записью ${other.id}`,
        conflictWith: other.id,
      };
    }
  }

  return { ok: true, message: 'адрес свободен' };
}

export function redirectsFor({
  recordId,
  state,
}: {
  recordId: string;
  state: AddressState;
}): { from: string; to: string }[] {
  const record = state.records.find((r) => r.id === recordId);
  if (!record) return [];

  const currentAddress = addressOf({ type: record.type, identifier: record.identifier });
  const previousAddresses = new Set(
    state.addressHistory
      .filter((entry) => entry.ownerId === recordId && entry.address !== currentAddress)
      .map((entry) => entry.address),
  );

  return [...previousAddresses].map((from) => ({ from, to: currentAddress }));
}

const contentAddress: ContentAddress = { isValidIdentifier, addressOf, checkIdentifier, redirectsFor };
export default contentAddress;
