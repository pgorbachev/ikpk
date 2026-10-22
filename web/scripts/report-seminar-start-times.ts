/** Read-only report; exit nonzero until every active current/future start is confirmed. */
import { readFileSync } from 'node:fs';
import { seminarStartReport } from './lib/seminar-start-contract.ts';
import type { Snapshot } from './lib/content-snapshot.ts';

const path = process.argv[2];
if (!path) throw new Error('Usage: tsx scripts/report-seminar-start-times.ts /path/to/snapshot.json');
const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
const issues = seminarStartReport(snapshot);
console.log(JSON.stringify({ referenceDate: snapshot.referenceDate, unresolved: issues.length, issues }, null, 2));
if (issues.length) process.exitCode = 1;
