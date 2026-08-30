import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  join(ROOT, 'discovery', 'url_map.csv'),
  join(ROOT, 'fixtures', 'content-snapshot', 'url_map.csv'),
];

const INSTITUTE_SEGMENTS = new Set([
  'institut-klinicheskoy-prikladnoy-kineziologii',
  'institut-apledzhera',
  'institut-barralya',
]);

const CATALOG_BY_PAGE_TYPE: Record<string, string> = {
  static_or_institute: 'instituty',
  course_group: 'programmy',
  seminar: 'seminary',
  teacher: 'specialisty',
};

function firstSegment(path: string): string {
  return path.split(/[?#]/)[0].split('/').filter(Boolean)[0] ?? '';
}

function flatten(text: string): { text: string; changed: number } {
  const lines = text.split('\n');
  const header = lines[0]?.split(',') ?? [];
  const newPathIndex = header.indexOf('new_path');
  const pageTypeIndex = header.indexOf('page_type');
  if (newPathIndex < 0 || pageTypeIndex < 0) throw new Error('url_map.csv: нет new_path или page_type');

  let changed = 0;
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index]) continue;
    // Первые восемь колонок карты не содержат запятых до `title`; split/join поэтому
    // сохраняет кавычки и запятые в хвосте строки без изменения.
    const cells = lines[index].split(',');
    const current = cells[newPathIndex] ?? '';
    if (!INSTITUTE_SEGMENTS.has(firstSegment(current))) continue;

    const catalog = CATALOG_BY_PAGE_TYPE[cells[pageTypeIndex] ?? ''];
    if (!catalog) throw new Error(`неизвестный page_type для иерархической цели: ${lines[index]}`);
    const slug = current.split(/[?#]/)[0].split('/').filter(Boolean).at(-1);
    if (!slug) throw new Error(`не удалось получить идентификатор из цели: ${current}`);
    cells[newPathIndex] = `/${catalog}/${slug}`;
    lines[index] = cells.join(',');
    changed++;
  }

  const remaining = lines.filter((line, index) => {
    if (index === 0 || !line) return false;
    return INSTITUTE_SEGMENTS.has(firstSegment(line.split(',')[newPathIndex] ?? ''));
  });
  if (remaining.length > 0) throw new Error(`остались иерархические цели: ${remaining.length}`);
  return { text: lines.join('\n'), changed };
}

const source = readFileSync(TARGETS[0], 'utf-8');
for (const target of TARGETS) {
  const current = readFileSync(target, 'utf-8');
  if (current !== source) throw new Error(`${target}: копия url_map.csv разошлась с discovery`);
}

const result = flatten(source);
for (const target of TARGETS) {
  const temp = `${target}.tmp`;
  writeFileSync(temp, result.text, 'utf-8');
  renameSync(temp, target);
}
console.log(`обновлено целей: ${result.changed}; карты: ${TARGETS.length}`);
