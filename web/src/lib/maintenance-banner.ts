const maintenanceBannerEnv =
  (import.meta as ImportMeta & { env?: { MAINTENANCE_BANNER?: unknown } }).env?.MAINTENANCE_BANNER ??
  (typeof process !== 'undefined' ? process.env?.MAINTENANCE_BANNER : undefined);
const mode = String(maintenanceBannerEnv ?? '').trim();

if (mode !== '' && mode !== 'on' && mode !== 'off') {
  throw new Error(
    `неизвестное значение MAINTENANCE_BANNER=${JSON.stringify(mode)}; допустимо: on|off`,
  );
}

/** Static output changes only after rebuilding and publishing. Default: off. */
export const isMaintenanceBannerEnabled = mode === 'on';
