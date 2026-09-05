/**
 * Соответствие «числовой id преподавателя → его legacy_id».
 *
 * Форма `legacy_id` в discovery-данных НЕ одна, и это выяснилось падением импорта:
 * у 28 преподавателей из 29 это число (`85`), у остальных — путь
 * (`…/prepodavatel/85`). Прежняя реализация принимала только вторую форму и звала
 * `.split` на числе.
 */
export function buildTeacherNumericMap(
  teachers: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const teacher of teachers) {
    const raw = teacher.legacy_id;
    if (raw === null || raw === undefined) continue;
    const legacyId = String(raw);
    const numeric = legacyId.split('/').pop() ?? '';
    if (/^\d+$/.test(numeric)) map.set(numeric, legacyId);
  }
  return map;
}
