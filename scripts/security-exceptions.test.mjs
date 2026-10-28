import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditResult } from './security-audit-policy.mjs';

const reportText = readFileSync(new URL('./fixtures/cms-security-audit-report-run-40722772948.json', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('./fixtures/cms-security-exceptions.approved-fixture.json', import.meta.url), 'utf8'));
const lockfileText = readFileSync(new URL('../cms/package-lock.json', import.meta.url), 'utf8');
const activePolicyText = readFileSync(new URL('../.github/security-exceptions.json', import.meta.url), 'utf8');
const now = new Date('2026-10-28T00:00:00Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evaluate({
  audit = JSON.parse(reportText),
  exceptions = clone(policy),
  lockfile = JSON.parse(lockfileText),
  npmStatus = 1,
  at = now,
} = {}) {
  return auditResult(JSON.stringify(audit), npmStatus, {
    component: 'cms',
    lockfileText: JSON.stringify(lockfile),
    exceptionsPolicyText: JSON.stringify(exceptions),
    now: at,
  });
}

test('seven synthetic approved GHSA fixtures tolerate only their 26 inherited high findings', () => {
  const result = evaluate();
  assert.equal(result.passed, true);
  assert.equal(result.toleratedBlockingFindings, 26);
  assert.equal(result.blockingFindings, 0);
  assert.equal(result.counts.high, 26);
  assert.equal(result.counts.critical, 0);
  assert.equal(result.counts.moderate, 16);
  assert.equal(result.counts.low, 2);
});

test('empty active policy leaves the CMS audit red and raw npm status remains mandatory', () => {
  const result = auditResult(reportText, 1, {
    component: 'cms',
    lockfileText,
    exceptionsPolicyText: activePolicyText,
    now,
  });
  assert.equal(result.passed, false);
  assert.equal(result.toleratedBlockingFindings, 0);
  assert.equal(result.blockingFindings, 26);
  assert.throws(() => auditResult(reportText, 0, {
    component: 'cms',
    lockfileText,
    exceptionsPolicyText: JSON.stringify(policy),
    now,
  }), /despite high or critical/);
});

test('unknown advisories, stale nodes, ranges, and severity escalation fail closed', () => {
  const unknown = clone(policy);
  unknown.exceptions[0].advisory = 'GHSA-aaaa-bbbb-cccc';
  assert.throws(() => evaluate({ exceptions: unknown }), /does not match this audit report/);

  const stale = clone(policy);
  stale.exceptions[0].lock_nodes[0].version = '1.29.1';
  assert.throws(() => evaluate({ exceptions: stale }), /lock node version/);

  const range = clone(policy);
  range.exceptions[0].lock_nodes[0].version = '>=1.29.0';
  assert.throws(() => evaluate({ exceptions: range }), /invalid lock node version/);

  const wildcardComponent = clone(policy);
  wildcardComponent.exceptions[0].component = '*';
  assert.throws(() => evaluate({ exceptions: wildcardComponent }), /unknown component/);

  const wildcardPackage = clone(policy);
  wildcardPackage.exceptions[0].package = '*';
  assert.throws(() => evaluate({ exceptions: wildcardPackage }), /invalid package/);

  const unrelatedPath = clone(policy);
  unrelatedPath.exceptions[0].lock_nodes[0].path = 'node_modules/other';
  assert.throws(() => evaluate({ exceptions: unrelatedPath }), /path does not match package/);

  const escalated = clone(JSON.parse(reportText));
  escalated.vulnerabilities['@modelcontextprotocol/sdk'].severity = 'critical';
  escalated.metadata.vulnerabilities.high -= 1;
  escalated.metadata.vulnerabilities.critical += 1;
  assert.throws(() => evaluate({ audit: escalated }), /did not match severity and node scope/);

  const criticalCause = clone(JSON.parse(reportText));
  criticalCause.vulnerabilities['@modelcontextprotocol/sdk'].via[0].severity = 'critical';
  assert.throws(() => evaluate({ audit: criticalCause }), /did not match severity and node scope/);
});

test('expired, malformed, and pending records cannot tolerate findings', () => {
  assert.throws(() => evaluate({ at: new Date('2026-11-11T00:00:00Z') }), /is expired/);
  assert.throws(() => evaluate({ at: new Date('invalid') }), /valid evaluation time/);

  const impossibleDate = clone(policy);
  impossibleDate.exceptions[0].expires_at = '2026-02-30T00:00:00Z';
  assert.throws(() => evaluate({ exceptions: impossibleDate }), /invalid UTC expiry/);

  const malformed = clone(policy);
  malformed.exceptions[0].source_evidence.revision = 'short';
  assert.throws(() => evaluate({ exceptions: malformed }), /invalid evidence revision/);

  const pending = clone(policy);
  for (const exception of pending.exceptions) {
    exception.decision = 'PENDING';
    exception.decision_reference = null;
  }
  assert.equal(evaluate({ exceptions: pending }).passed, false);
});

test('cycles and unresolved aggregate causes remain blocking', () => {
  const cyclic = clone(JSON.parse(reportText));
  cyclic.vulnerabilities['@strapi/core'].via.push('@strapi/core');
  assert.equal(evaluate({ audit: cyclic }).passed, false);

  const unresolved = clone(JSON.parse(reportText));
  unresolved.vulnerabilities['@strapi/core'].via.push('not-in-report');
  assert.equal(evaluate({ audit: unresolved }).passed, false);
});
