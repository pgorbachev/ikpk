export interface CandidateCityRow {
  city?: { name?: string } | string | null;
}

export interface SelectableCandidateCity<Row> {
  row: Row;
  name: string;
  value: string;
}

export function cityFilterValue(name: string): string {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

export function firstSelectableCandidateCity<Row extends CandidateCityRow>(
  rows: readonly Row[],
  availableValues: readonly string[],
): SelectableCandidateCity<Row> | undefined {
  for (const row of rows) {
    const name = typeof row.city === 'string' ? row.city : row.city?.name ?? '';
    const value = cityFilterValue(name);
    if (name.trim() && value && availableValues.includes(value)) return { row, name, value };
  }
  return undefined;
}
