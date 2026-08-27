/**
 * Разбор файла свидетельств приёмки и вердикт по нему.
 *
 * ── ЗАЧЕМ ЭТО ВООБЩЕ АВТОМАТИЗИРУЕТСЯ ───────────────────────────────────────
 * «Подтверждено приёмкой со сохранённым свидетельством» само по себе предмета не имеет:
 * места хранения свидетельств в репозитории до этого change не было, и приёмочный
 * сценарий не мог покраснеть НИ В ОДНОМ состоянии — то есть ручная проверка с названной
 * причиной превращалась в отсутствие проверки. Спека закрыла это, назвав путь файла и
 * машинно сопоставимую форму записи: заголовок, дословно совпадающий с именем сценария,
 * и перечень обязательных полей.
 *
 * Отсюда предмет разбора: НАЛИЧИЕ и ПОЛНОТА записи, а не качество наблюдения. Судить,
 * содержит ли свободный текст доказательство, объективного критерия не имеет — поэтому
 * непустота предмета названа спекой ПОЛЕМ, а не требованием к прозе, и здесь проверяется
 * именно наличие непустого поля.
 *
 * Имена полей — шов, выбранный тестами: спека называет их состав («что проверено, кем,
 * дату, наблюдение, доказательство непустоты предмета отдельным обязательным полем и
 * ссылку на источник, если он есть»), но не начертание, а разбору нужно начертание.
 */

/** Обязательные поля записи. Порядок — тот, в котором их перечисляет спека. */
export const REQUIRED_FIELDS = [
  'Что проверено',
  'Кем',
  'Дата',
  'Наблюдение',
  'Непустота предмета',
] as const;

/** Необязательное поле: ссылка на источник, «если он есть». */
export const OPTIONAL_FIELDS = ['Источник'] as const;

export interface EvidenceRecord {
  /** Заголовок записи — обязан дословно совпадать с именем сценария. */
  readonly heading: string;
  /** Значения полей по имени. Пустая строка означает «поле есть, а значения нет». */
  readonly fields: Readonly<Record<string, string>>;
  /** Полный текст записи — для сообщений об отказе. */
  readonly body: string;
}

/**
 * Разбор файла в записи.
 *
 * Записью считается раздел уровня `##`. Заголовок первого уровня и проза до первого `##`
 * записями не являются — это описание файла, а не свидетельство.
 *
 * Поле — строка вида `- **Имя:** значение`. Начертание одно, а не «любое похожее»:
 * приблизительный разбор в этом репозитории дважды давал обход гейта, а здесь цена
 * промаха — запись, признанная полной без одного из обязательных полей.
 */
export function parseEvidence(text: string): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  let heading: string | null = null;
  let lines: string[] = [];

  const flush = (): void => {
    if (heading === null) return;
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const match = /^\s*[-*]\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
      if (match !== null) fields[match[1].trim()] = match[2].trim();
    }
    records.push({ heading, fields, body: lines.join('\n') });
    heading = null;
    lines = [];
  };

  for (const line of text.split('\n')) {
    const h2 = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    if (h2 !== null) {
      flush();
      heading = h2[1].trim();
      continue;
    }
    if (/^#\s+/.test(line) || /^###+\s+/.test(line)) {
      // Заголовок другого уровня запись не открывает и не закрывает: `###` внутри записи
      // законен, `#` бывает только у названия файла.
      if (heading !== null) lines.push(line);
      continue;
    }
    if (heading !== null) lines.push(line);
  }
  flush();
  return records;
}

/** Приёмочный пункт: имя сценария плюс вычислимая применимость. */
export interface AcceptancePoint {
  /** Имя сценария спеки — оно же обязано быть заголовком записи. */
  readonly scenario: string;
  /** Условен ли пункт. Безусловный требует записи всегда. */
  readonly conditional: boolean;
  /** Наступило ли условие. У безусловного — всегда `true`. */
  readonly applicable: boolean;
  /**
   * Удалось ли вычислить применимость.
   *
   * Отдельным полем, а не пустой строкой в `because`: «нечего проверять» не равно
   * «проверять не требуется», и склейка этих двух исходов — ровно та подмена, против
   * которой написано всё требование.
   */
  readonly measurable: boolean;
  /** Чем применимость вычислена — попадает в сообщение об отказе. */
  readonly because: string;
  /**
   * Значение, которое запись обязана назвать, если оно есть.
   *
   * Нужно ровно одному пункту — про подъём байтового предела: спека требует, чтобы
   * «объявленное значение совпало с константой». У остальных `null`.
   */
  readonly mustMention?: string | null;
}

export type EvidenceProblem =
  | { readonly kind: 'missing'; readonly scenario: string; readonly detail: string }
  | { readonly kind: 'incomplete'; readonly scenario: string; readonly detail: string }
  | { readonly kind: 'stale'; readonly scenario: string; readonly detail: string }
  | { readonly kind: 'unmeasurable'; readonly scenario: string; readonly detail: string };

/**
 * Вердикт приёмки по файлу свидетельств.
 *
 * Исходов ЧЕТЫРЕ, и они различны намеренно:
 *
 *  - `missing` — условие наступило, а записи нет: приёмка непройдена;
 *  - `incomplete` — запись есть, но не несёт обязательного поля (в том числе
 *    доказательства непустоты предмета): «текстов отзывов нет» на сломанной секции верно
 *    тривиально, и именно этот случай требование о непустоте запрещает;
 *  - `stale` — запись есть, а приёмочного пункта с таким именем нет: заголовок разошёлся
 *    с именем сценария, и связать запись со сценарием больше нечем;
 *  - `unmeasurable` — применимость пункта вычислить не удалось. Это НЕ «пункт
 *    неприменим»: склейка «нечего проверять» с «проверять не требуется» — ровно та
 *    подмена, против которой всё требование и написано.
 *
 * Запись под пункт, чьё условие НЕ наступило, приёмку не роняет и её отсутствие тоже:
 * иначе правило требовало бы вписывать свидетельство ни о чём.
 */
export function evidenceProblems(
  records: readonly EvidenceRecord[],
  points: readonly AcceptancePoint[],
): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const byHeading = new Map(records.map((r) => [r.heading, r]));

  for (const point of points) {
    if (!point.measurable) {
      problems.push({
        kind: 'unmeasurable',
        scenario: point.scenario,
        detail:
          'применимость пункта вычислить не удалось: спека требует, чтобы она была вычислима ' +
          'из репозитория, а «нечего проверять» не равно «проверять не требуется»',
      });
      continue;
    }
    const record = byHeading.get(point.scenario);
    if (!point.applicable) {
      // Условие не наступило: записи не требуется, и её отсутствие приёмку не роняет.
      // Существующая запись при этом тоже не проблема — свидетельство, снятое заранее,
      // хуже не делает.
      continue;
    }
    if (record === undefined) {
      problems.push({
        kind: 'missing',
        scenario: point.scenario,
        detail: `условие наступило (${point.because}), а записи под этот сценарий в файле нет`,
      });
      continue;
    }
    const empty = REQUIRED_FIELDS.filter((name) => (record.fields[name] ?? '') === '');
    if (empty.length > 0)
      problems.push({
        kind: 'incomplete',
        scenario: point.scenario,
        detail: `нет обязательных полей либо они пусты: ${empty.join(', ')}`,
      });
    const date = record.fields.Дата ?? '';
    if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      problems.push({
        kind: 'incomplete',
        scenario: point.scenario,
        detail: `дата '${date}' записана не в форме ГГГГ-ММ-ДД: сравнивать её нечем`,
      });
    const mention = point.mustMention ?? null;
    if (mention !== null && !normalizeDigits(record.body).includes(normalizeDigits(mention)))
      problems.push({
        kind: 'incomplete',
        scenario: point.scenario,
        detail: `запись не называет значения '${mention}', которое обязано совпасть с константой`,
      });
  }

  const known = new Set(points.map((p) => p.scenario));
  for (const record of records)
    if (!known.has(record.heading))
      problems.push({
        kind: 'stale',
        scenario: record.heading,
        detail:
          'заголовок записи не совпадает ни с одним приёмочным сценарием: множество названо ' +
          'поимённо и закрыто, а запись без сценария связать со сценарием нечем',
      });

  return problems;
}

/** Числа в записи человек пишет с разделителями разрядов — сравнивать надо без них. */
function normalizeDigits(text: string): string {
  const SEPARATORS = /[\u00a0\u202f\s]+/g;
  return text.replace(SEPARATORS, (run: string, at: number) =>
    /\d/.test(text[at - 1] ?? '') && /\d/.test(text[at + run.length] ?? '') ? '' : run,
  );
}
