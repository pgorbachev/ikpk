import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditResult, parseAuditReport } from './security-audit-policy.mjs';
import { evaluateSecurityPolicy } from './verify-security-policy.mjs';

const workflow = readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8');
const emptyAudit = JSON.stringify({ metadata: { vulnerabilities: {
  critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0,
} } });
const allSuccess = Object.fromEntries([
  'SECRET_SCAN', 'RUNTIME_AUDITS', 'CMS_RUNTIME_AUDIT', 'FULL_AUDITS', 'CODEQL', 'POLICY_TESTS',
].map((producer) => [producer, 'success']));

test('validates complete npm audit severity measurements', () => {
  assert.equal(parseAuditReport(emptyAudit).total, 0);
  assert.throws(() => parseAuditReport('{broken'), /valid JSON/);
  assert.throws(() => parseAuditReport(JSON.stringify({ error: { code: 'E404' } })), /reported an error/);
  assert.throws(() => parseAuditReport('{"metadata":{"vulnerabilities":{}}}'), /invalid critical count/);
  assert.throws(() => parseAuditReport(JSON.stringify({ metadata: { vulnerabilities: {
    critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 0,
  } } })), /does not match/);
});

test('distinguishes passing audits, blocking findings, and measurement errors', () => {
  assert.equal(auditResult(emptyAudit, 0).passed, true);
  const highFinding = JSON.stringify({ metadata: { vulnerabilities: {
    critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1,
  } } });
  assert.equal(auditResult(highFinding, 1).passed, false);
  assert.throws(() => auditResult(highFinding, 0), /despite high or critical/);
  assert.throws(() => auditResult(emptyAudit, 1), /no high or critical/);
});

test('fails closed for failed, skipped, neutral, cancelled, pending, and missing producers', () => {
  assert.equal(evaluateSecurityPolicy(allSuccess).passed, true);
  for (const result of ['failure', 'skipped', 'neutral', 'cancelled', 'pending', '']) {
    assert.equal(evaluateSecurityPolicy({ ...allSuccess, CODEQL: result }).passed, false, result);
  }
  const incomplete = { ...allSuccess };
  delete incomplete.FULL_AUDITS;
  assert.deepEqual(evaluateSecurityPolicy(incomplete).missing, ['FULL_AUDITS']);
});

test('workflow declares the complete package and language matrices and gates every producer', () => {
  const fullAudit = workflow.split('  full-dependency-audit:')[1]?.split('  codeql-analysis:')[0] ?? '';
  const codeql = workflow.split('  codeql-analysis:')[1]?.split('  security-policy-tests:')[0] ?? '';
  const policy = workflow.split('  security-policy:')[1] ?? '';
  for (const packageName of ['web', 'cms', 'scripts', 'payments']) {
    assert.match(fullAudit, new RegExp(`- ${packageName}\\n`));
  }
  for (const language of ['javascript-typescript', 'python', 'actions']) {
    assert.match(codeql, new RegExp(`- ${language}\\n`));
  }
  for (const producer of ['secret-scan', 'dependency-audit', 'cms-dependency-report', 'full-dependency-audit', 'codeql-analysis', 'security-policy-tests']) {
    assert.match(policy, new RegExp(`- ${producer}\\n`));
  }
  for (const [envName, jobId] of [
    ['SECRET_SCAN', 'secret-scan'],
    ['RUNTIME_AUDITS', 'dependency-audit'],
    ['CMS_RUNTIME_AUDIT', 'cms-dependency-report'],
    ['FULL_AUDITS', 'full-dependency-audit'],
    ['CODEQL', 'codeql-analysis'],
    ['POLICY_TESTS', 'security-policy-tests'],
  ]) {
    assert.match(policy, new RegExp(`${envName}: \\$\\{\\{ needs\\.${jobId}\\.result \\}\\}`));
  }
  assert.match(policy, /if: always\(\)/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
