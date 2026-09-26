/** Публичное название проведения — опубликованное имя связанного семинара из того же снимка. */
export function publicScheduleTitle(entry: {
  seminar?: { name?: string | null } | null;
}): string {
  const title = entry.seminar?.name?.trim() ?? '';
  if (!title) {
    throw new Error('у проведения в снимке нет опубликованного названия семинара');
  }
  return title;
}
