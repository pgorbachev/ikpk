/**
 * Одна политика схем для rich HTML и для ссылок записи и акций.
 * Без node-модулей: этот файл попадает в клиентский бандл вместе с формами.
 */

export const ORACLE_BASE = 'https://oracle.test/page';

function stripControls(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) out += value[i];
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function rawCanonical(value: string): string {
  return stripControls(decodeEntities(value)).trim();
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function specialUrl(value: string): string {
  return rawCanonical(value).replace(/\\/g, '/');
}

function schemeProbe(value: string): string {
  return percentDecode(specialUrl(value)).toLowerCase().replace(/\s+/g, '');
}

export function parseBrowserUrl(value: string): URL | null {
  const special = specialUrl(value);
  if (!special) return null;
  try {
    return new URL(special, ORACLE_BASE);
  } catch {
    return null;
  }
}

export function forbiddenUrl(value: string): boolean {
  const probe = schemeProbe(value);
  if (probe.startsWith('//')) return true;
  return ['javascript:', 'vbscript:', 'file:', 'data:'].some((scheme) => probe.startsWith(scheme));
}

export function isAllowedHref(value: string): boolean {
  const special = specialUrl(value);
  if (!special) return false;
  if (forbiddenUrl(value)) return false;
  const probe = schemeProbe(value);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (!['http', 'https', 'mailto', 'tel'].includes(scheme)) return false;
    if (scheme === 'http' || scheme === 'https') {
      const parsed = parseBrowserUrl(value);
      if (!parsed || parsed.username || parsed.password) return false;
    }
    return true;
  }
  const parsed = parseBrowserUrl(value);
  if (!parsed) return false;
  return parsed.origin === new URL(ORACLE_BASE).origin;
}

/** Исходное значение, если схема допустима, иначе пустая строка. */
export function safeHref(value: string | null | undefined): string {
  if (!value) return '';
  return isAllowedHref(value) ? value : '';
}
