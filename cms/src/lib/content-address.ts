/**
 * СИНХРОНИЗИРОВАННАЯ КОПИЯ `scripts/lib/cms-content-address.ts`.
 *
 * `cms` и `scripts` — независимые npm-пакеты без общего workspace (в корне репозитория нет
 * `package.json` с `workspaces`), а `cms/tsconfig.json` держит `rootDir: "."`: импорт файла
 * снаружи `cms/` валит `tsc` ("File is not under 'rootDir'"), потому что Strapi собирает
 * `dist/` относительно `cms/`. Дублирование — сознательный компромисс, а не недосмотр; он
 * назван находкой в отчёте по задаче (варианты закрытия: npm workspaces на весь репозиторий
 * либо публикация `scripts/lib` как отдельного собираемого пакета).
 *
 * Логика ДОЛЖНА оставаться идентичной `scripts/lib/cms-content-address.ts` (там же и тесты,
 * 42 сценария). Здесь — только адаптация типов под то, что реально известно на стороне Strapi.
 */

export type RecordType =
  | 'institute'
  | 'course-group'
  | 'seminar'
  | 'person'
  | 'article'
  | 'video-playlist'
  | 'static-page';

export const CATALOG_BY_TYPE: Readonly<Record<Exclude<RecordType, 'static-page'>, string>> = {
  institute: '/instituty',
  'course-group': '/programmy',
  seminar: '/seminary',
  person: '/specialisty',
  article: '/statyi',
  'video-playlist': '/video',
};

export interface RecordRef {
  id: string;
  type: RecordType;
  identifier: string;
  previousAddresses?: string[];
}

export interface AddressState {
  records: RecordRef[];
  addressHistory: { address: string; ownerId: string }[];
  buildRouteSegments: string[];
}

export interface Verdict {
  ok: boolean;
  message: string;
  conflictWith?: string;
}

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

  // G1 (ревью PR #186, третий раунд): эта проверка — read-then-write без транзакции и без
  // защиты со стороны БД. Гонка одного каталожного типа (два института с одним slug) не
  // добирается сюда — её ловит уникальный индекс Strapi на `slug` раньше. У КРЕСТ-типовой
  // коллизии (институт против статической страницы, только эта ветка) такой защиты нет:
  // два редактора, создающие «x»-институт и «x»-страницу почти одновременно, оба могут
  // пройти это чтение до того, как первая запись зафиксируется. Результат — не потерянное
  // сохранение, а падение сборки `web` на дубле маршрута при следующей публикации. Принято
  // как известный риск с низкой вероятностью (нужны два одновременных редактора одного и
  // того же корневого сегмента), а не исправлено — правильный фикс требует транзакционных
  // гарантий Strapi, которые нельзя проверить фейковым Strapi-харнессом тестов этого файла.


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
