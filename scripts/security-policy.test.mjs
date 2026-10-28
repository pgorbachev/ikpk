import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { auditResult, parseAuditReport } from './security-audit-policy.mjs';
import { evaluateSecurityPolicy } from './verify-security-policy.mjs';

const requireWebDependency = createRequire(new URL('../web/package.json', import.meta.url));
const { parse: parseYaml } = requireWebDependency('yaml');
const workflow = parseYaml(readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8'));
const cleanAudit = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
    dependencies: { prod: 1, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 3 },
  },
});
const allSuccess = Object.fromEntries([
  'SECRET_SCAN', 'RUNTIME_AUDITS', 'CMS_RUNTIME_AUDIT', 'FULL_AUDITS', 'CODEQL', 'POLICY_TESTS',
].map((producer) => [producer, 'success']));

function hasContinueOnError(value) {
  if (!value || typeof value !== 'object') return false;
  if (value['continue-on-error'] === true) return true;
  return Object.values(value).some(hasContinueOnError);
}

function assertNoConditions(job, allowedStepConditions = {}) {
  assert.equal(job.if, undefined, 'producer job must run without a job condition');
  for (const step of job.steps ?? []) {
    if (step.if !== undefined) {
      assert.equal(step.if, allowedStepConditions[step.name], `unexpected step condition on ${step.name}`);
    }
  }
}

test('validates a real npm audit v2 report and rejects truncated or inconsistent reports', () => {
  assert.equal(parseAuditReport(cleanAudit).total, 0);
  assert.throws(() => parseAuditReport('{broken'), /valid JSON/);
  assert.throws(() => parseAuditReport(JSON.stringify({
    metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 } },
  })), /auditReportVersion/);
  assert.throws(() => parseAuditReport(JSON.stringify({ error: { code: 'E404' } })), /reported an error/);
  assert.throws(() => parseAuditReport(JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1 },
      dependencies: { prod: 1, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 3 },
    },
  })), /does not match/);
  assert.throws(() => parseAuditReport(JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 },
      dependencies: { prod: 0, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 0 },
    },
  })), /non-empty/);
});

test('distinguishes passing audits, blocking findings, and measurement errors', () => {
  assert.equal(auditResult(cleanAudit, 0).passed, true);
  const highAudit = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      sample: { name: 'sample', severity: 'high', isDirect: true, via: [], effects: [], range: '*', nodes: ['node_modules/sample'], fixAvailable: false },
    },
    metadata: {
      vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1 },
      dependencies: { prod: 1, dev: 2, optional: 0, peer: 0, peerOptional: 0, total: 3 },
    },
  });
  assert.equal(auditResult(highAudit, 1).passed, false);
  assert.throws(() => auditResult(highAudit, 0), /despite high or critical/);
  assert.throws(() => auditResult(cleanAudit, 1), /no high or critical/);
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

test('declares complete package and CodeQL matrices with unconditional security producers', () => {
  const jobs = workflow.jobs;
  assert.deepEqual(jobs['full-dependency-audit'].strategy.matrix.package, ['web', 'cms', 'scripts', 'payments']);
  assert.deepEqual(jobs['codeql-analysis'].strategy.matrix.language, ['javascript-typescript', 'python', 'actions']);
  for (const id of ['secret-scan', 'dependency-audit', 'cms-dependency-audit', 'full-dependency-audit', 'codeql-analysis', 'security-policy-tests']) {
    const allowedConditions = {
      'cms-dependency-audit': {
        'Upload runtime audit report': 'always()',
        'Visibility note': 'always()',
      },
      'full-dependency-audit': { 'Upload full dependency audit report': 'always()' },
    }[id] ?? {};
    assertNoConditions(jobs[id], allowedConditions);
  }

  const fullAuditSteps = jobs['full-dependency-audit'].steps;
  const install = fullAuditSteps.find((step) => step.name === 'Install complete dependency tree');
  const audit = fullAuditSteps.find((step) => step.name === 'Audit runtime and development dependencies');
  const upload = fullAuditSteps.find((step) => step.name === 'Upload full dependency audit report');
  assert.match(install.run, /npm ci --include=dev --audit=false/);
  assert.match(audit.run, /npm audit --include=dev --audit-level=high --json/);
  assert.match(install.run, /-u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT/);
  assert.match(audit.run, /-u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT/);
  assert.equal(upload.if, 'always()');
  const codeqlSteps = jobs['codeql-analysis'].steps;
  const init = codeqlSteps.find((step) => step.name === 'Initialize CodeQL');
  const analyze = codeqlSteps.find((step) => step.name === 'Analyze');
  assert.deepEqual(init.with, { languages: '${{ matrix.language }}', queries: 'security-extended' });
  assert.deepEqual(analyze.with, { category: '/language:${{ matrix.language }}' });
  assert.ok(!hasContinueOnError(jobs), 'security producer or policy must not continue on error');
});

test('aggregate runs always and maps every declared producer result explicitly', () => {
  const policy = jobs['security-policy'];
  assert.equal(policy.if, 'always()');
  assert.deepEqual(policy.needs, [
    'secret-scan', 'dependency-audit', 'cms-dependency-audit', 'full-dependency-audit', 'codeql-analysis', 'security-policy-tests',
  ]);
  const mappedResults = policy.steps.find((step) => step.name === 'Require every security producer to succeed').env;
  assert.deepEqual(mappedResults, {
    SECRET_SCAN: '${{ needs.secret-scan.result }}',
    RUNTIME_AUDITS: '${{ needs.dependency-audit.result }}',
    CMS_RUNTIME_AUDIT: '${{ needs.cms-dependency-audit.result }}',
    FULL_AUDITS: '${{ needs.full-dependency-audit.result }}',
    CODEQL: '${{ needs.codeql-analysis.result }}',
    POLICY_TESTS: '${{ needs.security-policy-tests.result }}',
  });
  assert.ok(!hasContinueOnError(policy));
});

test('runs without path filters on PR, main push, and weekly schedule', () => {
  assert.ok(workflow.on.pull_request);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(workflow.on.schedule.some(({ cron }) => cron));
  assert.equal(workflow.on.pull_request.paths, undefined);
  assert.equal(workflow.on.pull_request.paths_ignore, undefined);
  assert.equal(workflow.on.push.paths, undefined);
});
