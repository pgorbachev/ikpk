import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Машинно читаемое объявление действующего релиза на раздаче (`/release.json`). */
export interface ReleaseDeclaration {
  commit: string;
  snapshotId: string;
}

export function parseReleaseDeclaration(raw: string): ReleaseDeclaration | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReleaseDeclaration>;
    if (typeof parsed.commit !== 'string' || parsed.commit.length === 0) return null;
    if (typeof parsed.snapshotId !== 'string' || parsed.snapshotId.length === 0) return null;
    return { commit: parsed.commit, snapshotId: parsed.snapshotId };
  } catch {
    return null;
  }
}

export function writeReleaseDeclaration(dir: string, declaration: ReleaseDeclaration): string {
  const path = join(dir, 'release.json');
  writeFileSync(path, `${JSON.stringify(declaration, null, 2)}\n`, 'utf-8');
  return path;
}

export async function fetchReleaseDeclaration(
  origin: string,
): Promise<{ observed: ReleaseDeclaration | null; httpStatus: number | null }> {
  const base = origin.replace(/\/$/, '');
  const url = `${base}/release.json`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    });
    if (response.status === 404) return { observed: null, httpStatus: 404 };
    if (!response.ok) return { observed: null, httpStatus: response.status };
    const text = await response.text();
    return { observed: parseReleaseDeclaration(text), httpStatus: response.status };
  } catch {
    return { observed: null, httpStatus: null };
  }
}
