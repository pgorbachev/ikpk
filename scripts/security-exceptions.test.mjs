import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditResult } from './security-audit-policy.mjs';

const reportText = readFileSync(new URL('./fixtures/cms-security-audit-report-run-40722772948.json', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('./fixtures/cms-security-exceptions.approved-fixture.json', import.meta.url), 'utf8'));
const lockfileText = readFileSync(new URL('../cms/package-lock.json', import.meta.url), 'utf8');
const emptyPolicyText = readFileSync(new URL('./fixtures/security-exceptions-empty.json', import.meta.url), 'utf8');
const now = new Date('2026-10-28T00:00:00Z');
const cleanReportText = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
    dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 },
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evaluate({
  audit = JSON.parse(reportText),
  exceptions = clone(policy),
  lockfile = JSON.parse(lockfileText),
  npmStatus = 1,
  at = now,
  trustedDigest,
} = {}) {
  const policyText = JSON.stringify(exceptions);
  const digest = trustedDigest === undefined
    ? createHash('sha256').update(policyText, 'utf8').digest('hex')
    : trustedDigest;
  return auditResult(JSON.stringify(audit), npmStatus, {
    component: 'cms',
    lockfileText: JSON.stringify(lockfile),
    exceptionsPolicyText: policyText,
    trustedPolicySha256: digest,
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

test('empty policy fixture leaves the CMS audit red and raw npm status remains mandatory', () => {
  const result = auditResult(reportText, 1, {
    component: 'cms',
    lockfileText,
    exceptionsPolicyText: emptyPolicyText,
    now,
  });
  assert.equal(result.passed, false);
  assert.equal(result.toleratedBlockingFindings, 0);
  assert.equal(result.blockingFindings, 26);
  assert.throws(() => auditResult(reportText, 0, {
    component: 'cms',
    lockfileText,
    exceptionsPolicyText: JSON.stringify(policy),
    trustedPolicySha256: createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex'),
    now,
  }), /despite high or critical/);
});

test('clean web, scripts, and payments reports pass with an explicit empty policy', () => {
  for (const component of ['web', 'scripts', 'payments']) {
    const result = auditResult(cleanReportText, 0, {
      component,
      lockfileText: readFileSync(new URL('../' + component + '/package-lock.json', import.meta.url), 'utf8'),
      exceptionsPolicyText: emptyPolicyText,
      now,
    });
    assert.equal(result.passed, true, component);
    assert.equal(result.toleratedBlockingFindings, 0, component);
  }
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
  assert.throws(() => evaluate({ audit: criticalCause }), /understates blocking severity/);
});

test('new GHSA, lock node, hidden cause, inherited reference, and critical aggregate remain blocking', () => {
  const newGhsa = clone(JSON.parse(reportText));
  const sdk = newGhsa.vulnerabilities['@modelcontextprotocol/sdk'];
  sdk.via.push({ ...sdk.via[0], url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', title: 'new unapproved advisory' });
  assert.equal(evaluate({ audit: newGhsa }).passed, false);

  const newNode = clone(JSON.parse(reportText));
  const sdkPath = 'node_modules/other/node_modules/@modelcontextprotocol/sdk';
  newNode.vulnerabilities['@modelcontextprotocol/sdk'].nodes.push(sdkPath);
  const lockfile = JSON.parse(lockfileText);
  lockfile.packages[sdkPath] = { version: '1.30.0' };
  assert.throws(() => evaluate({ audit: newNode, lockfile }), /does not match this audit report/);

  const hiddenCause = clone(JSON.parse(reportText));
  hiddenCause.vulnerabilities['@modelcontextprotocol/sdk'].severity = 'moderate';
  hiddenCause.metadata.vulnerabilities.high -= 1;
  hiddenCause.metadata.vulnerabilities.moderate += 1;
  assert.throws(() => evaluate({ audit: hiddenCause }), /understates blocking severity/);

  for (const inheritedName of ['constructor', '__proto__']) {
    const inherited = clone(JSON.parse(reportText));
    inherited.vulnerabilities['@strapi/core'].via.push(inheritedName);
    assert.throws(() => evaluate({ audit: inherited }), /unresolved package reference/);
  }

  const criticalParent = clone(JSON.parse(reportText));
  criticalParent.vulnerabilities['@strapi/core'].severity = 'critical';
  criticalParent.metadata.vulnerabilities.high -= 1;
  criticalParent.metadata.vulnerabilities.critical += 1;
  assert.equal(evaluate({ audit: criticalParent }).passed, false);

  const mixedParent = clone(JSON.parse(reportText));
  mixedParent.vulnerabilities['@strapi/core'].via.push({
    url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', severity: 'high', title: 'new unapproved cause',
  });
  assert.equal(evaluate({ audit: mixedParent }).passed, false);
});

test('approved records require the independent exact-file digest attestation', () => {
  assert.throws(() => evaluate({ trustedDigest: null }), /do not match SECURITY_EXCEPTION_POLICY_SHA256/);
  assert.throws(() => evaluate({ trustedDigest: '0'.repeat(64) }), /do not match SECURITY_EXCEPTION_POLICY_SHA256/);
  const forged = clone(policy);
  forged.exceptions[0].decision_reference = 'https://github.com/pgorbachev/ikpk/pull/999';
  const originalDigest = createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex');
  assert.throws(() => evaluate({ exceptions: forged, trustedDigest: originalDigest }), /do not match SECURITY_EXCEPTION_POLICY_SHA256/);
});

test('expired, malformed, and pending records cannot tolerate findings', () => {
  assert.throws(() => evaluate({ at: new Date('2026-11-11T00:00:00Z') }), /is expired/);
  assert.throws(() => evaluate({ at: new Date('invalid') }), /valid evaluation time/);

  const impossibleDate = clone(policy);
  impossibleDate.exceptions[0].expires_at = '2026-02-30T00:00:00Z';
  assert.throws(() => evaluate({ exceptions: impossibleDate }), /invalid UTC expiry/);

  const unknownTopLevel = clone(policy);
  unknownTopLevel.unreviewed = true;
  assert.throws(() => evaluate({ exceptions: unknownTopLevel }), /unknown top-level field/);

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
  assert.throws(() => evaluate({ audit: unresolved }), /unresolved package reference/);
});
