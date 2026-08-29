import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type EventMarker = 'edit' | 'restore' | 'initial-migration' | 'accept-state';

export interface LedgerEntry {
  number: number;
  fingerprint: string;
  previous: number | null;
  marker: EventMarker | null;
}

export interface Observation {
  observedEntry: number;
  revision: number | null;
  highWaterMark: number;
  requiresConfirmation: boolean;
  reason?: 'restore-with-unknown-fingerprint' | 'fingerprint-match-without-marker' | 'ledger-unavailable';
}

export interface ProvenanceLedger {
  recordEvent(event: { fingerprint: string; marker: EventMarker | null }): Promise<LedgerEntry>;
  entries(): Promise<readonly LedgerEntry[]>;
  highWaterMark(): Promise<number>;
  observe(state: { fingerprint: string }): Promise<Observation>;
  acceptState(state: { fingerprint: string; confirmedBy: string }): Promise<LedgerEntry>;
}

interface StoredEntry extends LedgerEntry {
  checksum: string;
}

const HWM_FILE = 'high-water-mark';
const OPTIONS_FILE = 'options.json';

function checksumOf(entry: LedgerEntry): string {
  return createHash('sha256')
    .update(JSON.stringify({ number: entry.number, fingerprint: entry.fingerprint, previous: entry.previous, marker: entry.marker }))
    .digest('hex');
}

function entryPath(dir: string, number: number): string {
  return join(dir, `entry-${String(number).padStart(6, '0')}.json`);
}

function readHwm(dir: string): number {
  const path = join(dir, HWM_FILE);
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, 'utf-8').trim();
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

function writeHwm(dir: string, value: number): void {
  const path = join(dir, HWM_FILE);
  const current = readHwm(dir);
  if (value < current) {
    throw new Error('high-water-mark must not decrease');
  }
  writeFileSync(path, `${value}\n`, 'utf-8');
}

function parseStored(raw: string): StoredEntry {
  const parsed = JSON.parse(raw) as StoredEntry;
  const expected = checksumOf(parsed);
  if (parsed.checksum !== expected) {
    throw new Error('журнал происхождения повреждён: контрольная сумма записи не совпадает');
  }
  return parsed;
}

function loadEntries(dir: string): LedgerEntry[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => /^entry-\d+\.json$/.test(name));
  const entries = files.map((name) => parseStored(readFileSync(join(dir, name), 'utf-8')));
  entries.sort((a, b) => a.number - b.number);
  return entries.map(({ number, fingerprint, previous, marker }) => ({ number, fingerprint, previous, marker }));
}

function firstOccurrence(entries: LedgerEntry[], fingerprint: string): LedgerEntry | undefined {
  return entries.find((entry) => entry.fingerprint === fingerprint);
}

function revisionOf(entries: LedgerEntry[], last: LedgerEntry): Pick<Observation, 'revision' | 'requiresConfirmation' | 'reason'> {
  const seenBefore = firstOccurrence(entries, last.fingerprint);
  const knownBeforeLast = seenBefore !== undefined && seenBefore.number < last.number;

  if (last.marker === 'restore') {
    if (!knownBeforeLast) {
      return { revision: null, requiresConfirmation: true, reason: 'restore-with-unknown-fingerprint' };
    }
    return { revision: seenBefore.number, requiresConfirmation: false };
  }

  if (last.marker === null) {
    if (knownBeforeLast) {
      return { revision: null, requiresConfirmation: true, reason: 'fingerprint-match-without-marker' };
    }
    return { revision: last.number, requiresConfirmation: false };
  }

  return { revision: last.number, requiresConfirmation: false };
}

class FileProvenanceLedger implements ProvenanceLedger {
  constructor(
    private readonly dir: string,
    private readonly hasPublicationHistory: boolean,
  ) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, OPTIONS_FILE), JSON.stringify({ hasPublicationHistory }), 'utf-8');
    if (!existsSync(join(dir, HWM_FILE))) writeHwm(dir, 0);
  }

  async recordEvent(event: { fingerprint: string; marker: EventMarker | null }): Promise<LedgerEntry> {
    mkdirSync(this.dir, { recursive: true });
    for (;;) {
      const current = loadEntries(this.dir);
      const last = current.at(-1);
      const number = (last?.number ?? 0) + 1;
      const entry: LedgerEntry = {
        number,
        fingerprint: event.fingerprint,
        previous: last?.number ?? null,
        marker: event.marker,
      };
      const stored: StoredEntry = { ...entry, checksum: checksumOf(entry) };
      try {
        writeFileSync(entryPath(this.dir, number), `${JSON.stringify(stored)}\n`, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      writeHwm(this.dir, Math.max(readHwm(this.dir), number));
      return entry;
    }
  }

  async entries(): Promise<readonly LedgerEntry[]> {
    return loadEntries(this.dir);
  }

  async highWaterMark(): Promise<number> {
    return readHwm(this.dir);
  }

  async observe(state: { fingerprint: string }): Promise<Observation> {
    const entries = loadEntries(this.dir);
    const hwm = readHwm(this.dir);
    if (entries.length === 0) {
      if (this.hasPublicationHistory) {
        return {
          observedEntry: 0,
          revision: null,
          highWaterMark: hwm,
          requiresConfirmation: true,
          reason: 'ledger-unavailable',
        };
      }
      return { observedEntry: 0, revision: null, highWaterMark: hwm, requiresConfirmation: false };
    }
    const last = entries.at(-1)!;
    // Ревизия считается для наблюдаемого отпечатка (состояние снимка), а не только
    // для байтов последней записи: при согласованном журнале они совпадают.
    const derived = revisionOf(entries, { ...last, fingerprint: state.fingerprint });
    return {
      observedEntry: last.number,
      highWaterMark: hwm,
      revision: derived.revision,
      requiresConfirmation: derived.requiresConfirmation,
      reason: derived.reason,
    };
  }

  async acceptState(state: { fingerprint: string; confirmedBy: string }): Promise<LedgerEntry> {
    void state.confirmedBy;
    return this.recordEvent({ fingerprint: state.fingerprint, marker: 'accept-state' });
  }
}

export function createLedger(options: { dir: string; hasPublicationHistory?: boolean }): ProvenanceLedger {
  return new FileProvenanceLedger(options.dir, options.hasPublicationHistory ?? false);
}
