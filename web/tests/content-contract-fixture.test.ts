import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshotContract } from '../scripts/lib/content-contract.ts';
import type { Snapshot } from '../scripts/lib/content-snapshot.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PINNED = join(REPO_ROOT, 'fixtures', 'content-snapshot', 'snapshot.json');

// РЕГРЕСС: контракт объявлял сломанной связь ВСЕХ 126 семинаров с их программами, потому что
// сравнивал `course_group_legacy_id` семинара с множеством СЛУГОВ программ. Поле называется
// `…_legacy_id`, и сравнивать его надо с `legacy_id`.
//
// Дефект дожил незамеченным, потому что контракт не запускается ни в одном обязательном пути:
// `prepare-snapshot.ts` копирует фикстуру БЕЗ проверки, а единственный вызывающий —
// `capture-content-snapshot.ts` — в цепочку сборки не входит. Гейт, который никто не исполняет,
// не отличается от отсутствующего.
describe('закреплённая фикстура и её собственный контракт', () => {
  const snapshot = JSON.parse(readFileSync(PINNED, 'utf-8')) as Snapshot;

  it('фикстура проходит контракт, который к ней применяют', () => {
    const { violations } = validateSnapshotContract(snapshot);
    const summary = violations
      .slice(0, 5)
      .map((v) => `${v.type}/${v.recordId}: ${v.rule}${v.field ? ` (${v.field})` : ''}`)
      .join('\n');
    expect(violations, `нарушений ${violations.length}:\n${summary}`).toEqual([]);
  });

  // Защита от вакуумности: контракт, которому нечего проверять, зелён по совпадению.
  it('в фикстуре есть, что проверять', () => {
    const types = (snapshot as unknown as { content: { types: Record<string, unknown[]> } }).content
      .types;
    expect(Object.keys(types).length, 'типов контента нет — проверка вакуумна').toBeGreaterThan(0);
    expect(types.seminars?.length ?? 0, 'семинаров нет — связь проверять не на чем').toBeGreaterThan(0);
    expect(types.course_groups?.length ?? 0, 'программ нет — связь проверять не на чем').toBeGreaterThan(0);
  });
});
