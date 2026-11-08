/**
 * Текст страницы «Обновить сайт».
 *
 * Фаза в настоящем времени («Проверяется выложенный релиз») имеет смысл только
 * пока операция идёт. После завершения та же фаза рядом с «HTTP 301» читается
 * как новая проверка, хотя это сохранённый результат прошлой попытки.
 */

const PHASE: Record<string, string> = {
  capture: 'Снимается опубликованный снимок',
  build: 'Собирается сайт',
  switching: 'Сайт переключается',
  verifying: 'Проверяется выложенный релиз',
  'host-publication': 'Публикация на хосте ещё идёт',
};

const WHEN = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export interface RefreshStatusView {
  status?: string | null;
  message?: string | null;
  phase?: string | null;
  detail?: string | null;
  releaseId?: string | null;
  commit?: string | null;
  finishedAt?: string | null;
}

export interface RefreshStatusLines {
  message: string;
  phase: string | null;
  attempt: string | null;
}

export function formatRefreshWhen(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    WHEN.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  if (!parts.day || !parts.month || !parts.year || !parts.hour || !parts.minute) return null;
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} МСК`;
}

function identity(view: RefreshStatusView): string {
  const parts: string[] = [];
  if (view.releaseId) parts.push(`релиз ${view.releaseId}`);
  if (view.commit) parts.push(`коммит ${view.commit}`);
  return parts.join(', ');
}

function detailSentence(detail: string): string {
  if (/^HTTP \d{3}$/.test(detail)) return `проверка этого релиза вернула ${detail}`;
  return detail;
}

export function refreshStatusLines(view: RefreshStatusView): RefreshStatusLines {
  const running = view.status === 'running';
  const message = view.message || 'Состояние ещё не загружено.';
  if (running) {
    let phase = view.phase ? PHASE[view.phase] ?? null : null;
    if (phase && view.releaseId) phase = `${phase}: ${view.releaseId}`;
    return { message, phase, attempt: null };
  }

  const when = view.finishedAt ? formatRefreshWhen(view.finishedAt) : null;
  const who = identity(view);
  const outcome = view.detail ? detailSentence(view.detail) : '';
  if (!when && !who && !outcome) return { message, phase: null, attempt: null };

  const head = when ? `Завершено ${when}` : 'Последняя сохранённая попытка';
  const named = who ? `${head} — ${who}` : head;
  if (!outcome) return { message, phase: null, attempt: `${named}.` };
  const sentence = `${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}`;
  const closed = sentence.endsWith('.') ? sentence : `${sentence}.`;
  return { message, phase: null, attempt: `${named}. ${closed}` };
}
