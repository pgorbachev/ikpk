const maintenanceBannerEnv =
  (import.meta as ImportMeta & { env?: { MAINTENANCE_BANNER?: unknown } }).env?.MAINTENANCE_BANNER ??
  (typeof process !== 'undefined' ? process.env?.MAINTENANCE_BANNER : undefined);
const mode = String(maintenanceBannerEnv ?? '').trim();

if (mode !== '' && mode !== 'on' && mode !== 'off') {
  throw new Error(
    `неизвестное значение MAINTENANCE_BANNER=${JSON.stringify(mode)}; допустимо: on|off`,
  );
}

/** Production builds keep the maintenance notice on unless explicitly disabled. */
export const isMaintenanceBannerEnabled = mode !== 'off';
