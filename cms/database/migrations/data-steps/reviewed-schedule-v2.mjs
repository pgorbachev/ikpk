import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditScheduleBusinessRules } from '../../../scripts/audit-schedule-business-rules-v2.mjs';
import { applyScheduleDataMigration } from '../../../scripts/migrate-schedule-data-v2.mjs';

const HASH = /^[a-f0-9]{64}$/;
const IMPLEMENTATION_DEPENDENCIES = [
  { path: '../../../scripts/audit-schedule-business-rules-v2.mjs', sha256: '8d124c880a5ca5f352389460c8887c33efb77fb2fdb7201e46520ee2e2213945' },
  { path: '../../../scripts/migrate-schedule-data-v2.mjs', sha256: '0471167863d54e929067683757c058e65b24a4775a003632e0ff3903c903cdd8' },
];
function fail(message) { throw new Error(`reviewed schedule migration: ${message}`); }
function verifyImplementationDependencies() {
  const base = dirname(fileURLToPath(import.meta.url));
  for (const dependency of IMPLEMENTATION_DEPENDENCIES) {
    const path = resolve(base, dependency.path), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail(`implementation dependency is not a regular file: ${dependency.path}`);
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== dependency.sha256) {
      fail(`implementation dependency hash mismatch: ${dependency.path}`);
    }
  }
}
function privateOwner(info, label) {
  if ((info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail(`${label} must be owner-only and owned by the current user`);
}

/** Read only from an externally hash-bound, private, non-symlink file.
 * The expected hashes come from the independently reviewed operation receipt,
 * never from this file. Call again on every resume before executing the step.
 */
export function readReviewedScheduleFile(path, expectedFileSha256, expectedPlanDigest) {
  verifyImplementationDependencies();
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path)) fail('review file must be a canonical absolute path');
  if (!HASH.test(expectedFileSha256 ?? '') || !HASH.test(expectedPlanDigest ?? '')) fail('independent file and plan digests are required');
  const parent = dirname(path), directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(parent) !== parent) fail('review directory must not traverse symlinks');
  privateOwner(directory, 'review directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 20_000_000) fail('review file must be a bounded, unlinked regular file');
    privateOwner(info, 'review file');
    const bytes = readFileSync(fd);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedFileSha256) fail('review file hash mismatch');
    let reviewed;
    try { reviewed = JSON.parse(bytes.toString('utf8')); } catch { fail('invalid review JSON'); }
    if (!reviewed || Object.keys(reviewed).sort().join(',') !== 'decisions,plan' || reviewed.plan?.planDigest !== expectedPlanDigest) fail('review file does not contain the approved plan');
    return reviewed;
  } finally { closeSync(fd); }
}

/** Runner seam: independent source check precedes the existing transactional writer.
 * The writer invokes onApplied before commit, allowing the runner ledger to commit
 * in the same transaction. This module does not choose an operation or database.
 */
export function apply(db, { reviewFilePath, expectedReviewFileSha256, expectedPlanDigest, onApplied } = {}) {
  const { plan, decisions } = readReviewedScheduleFile(reviewFilePath, expectedReviewFileSha256, expectedPlanDigest);
  auditScheduleBusinessRules(db, { plan, decisions, expectedPlanDigest });
  return applyScheduleDataMigration(db, { plan, decisions, expectedPlanDigest, onApplied });
}
