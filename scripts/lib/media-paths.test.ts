import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { resolveLocalPath, type MediaDirs } from './media-paths.js';

// Дефект B2 (docs/security-audit-2026-08-08.md): путь записи строился из строки,
// найденной регуляркой в данных, без проверки границы каталога. `filter(Boolean)`
// убирает только пустые сегменты — `..` проходит насквозь, `join` их схлопывает,
// и запись уезжает выше целевого каталога. Данные приходят с чужого живого сайта.
const DIRS: MediaDirs = {
  originalsDir: '/repo/media-originals',
  publicDir: '/repo/web/public',
};

/** Остался ли результат строго внутри одного из целевых каталогов. */
function isInside(localPath: string): boolean {
  return (
    resolve(localPath).startsWith(resolve(DIRS.originalsDir) + sep) ||
    resolve(localPath).startsWith(resolve(DIRS.publicDir) + sep)
  );
}

describe('resolveLocalPath — обычные пути', () => {
  it('/media/** кладётся в каталог оригиналов без префикса media', () => {
    expect(resolveLocalPath('/media/uploads/a.webp', DIRS)).toBe(
      '/repo/media-originals/uploads/a.webp',
    );
  });

  it('/terms/** кладётся внутрь web/public целиком', () => {
    expect(resolveLocalPath('/terms/doc.pdf', DIRS)).toBe('/repo/web/public/terms/doc.pdf');
  });
});

describe('resolveLocalPath — выход за границу каталога отвергается', () => {
  // Обе базы: у media отрезается первый сегмент, у остальных нет, поэтому
  // проверять надо каждую ветку отдельно.
  it('отвергает ../ в ветке media (каталог оригиналов)', () => {
    expect(() => resolveLocalPath('/media/../../../evil.png', DIRS)).toThrow();
  });

  it('отвергает ../ в ветке public', () => {
    expect(() => resolveLocalPath('/terms/../../../evil.png', DIRS)).toThrow();
  });

  // decodeURI (safeDecode в download-media.ts) не трогает зарезервированные
  // символы, но `%2E` в их число НЕ входит: `%2e%2e` доходит сюда уже как `..`.
  // Проверяется тот же слой, на который придёт декодированная строка.
  it('отвергает traversal, пришедший из percent-encoding', () => {
    expect(() => resolveLocalPath(decodeURI('/media/%2e%2e/%2e%2e/evil.png'), DIRS)).toThrow();
  });

  it('не отдаёт путь за пределами целевых каталогов ни в одном случае', () => {
    const hostile = [
      '/media/../../../evil.png',
      '/terms/../../../evil.png',
      decodeURI('/media/%2e%2e/%2e%2e/evil.png'),
      '/media/../../web/public/index.html',
    ];
    for (const path of hostile) {
      let result: string | null = null;
      try {
        result = resolveLocalPath(path, DIRS);
      } catch {
        continue; // отказ — правильный исход
      }
      expect(isInside(result), `${path} → ${result} вне целевых каталогов`).toBe(true);
    }
  });
});
