import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { REQUIRED_TEST_REPORTS, VIEWPORT_OMISSIONS, ROLE_OMISSIONS, VITEST_ROLE_OMISSIONS, ACCEPTED_DEVIATIONS, SOURCE_REPORT_PROFILE, NON_TEST_CHECKS, validateNativeTestReport,
  validateReportSummaries, collectTestReportSummaries } from '../release-test-reports.mjs';
import { SOURCE_SUITES } from '../release-test-policy.mjs';

const vitestDefinition = REQUIRED_TEST_REPORTS.find((entry) => entry.runner === 'vitest');
const tapDefinition = REQUIRED_TEST_REPORTS.find((entry) => entry.runner === 'tap');
const vitest = () => ({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
  testResults: [{ name: 'example.test.ts', assertionResults: [{ title: 'works', status: 'passed', failureMessages: [] }] }] });
function playwright(definition) {
  return { errors: [], stats: { expected: definition.files.length * definition.projects.length, unexpected: 0, flaky: 0, skipped: 0 },
    suites: definition.files.map((file) => ({ title: file, file, specs: [{ file, title: 'works',
      tests: definition.projects.map((projectName) => ({ projectName, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0 }] })) }] })) };
}
const validate = (report, definition) => validateNativeTestReport(JSON.stringify(report), definition);

test('every test suite has one native report; native non-test checks are named separately', () => {
  assert.deepEqual([...REQUIRED_TEST_REPORTS.map((entry) => entry.suite), ...NON_TEST_CHECKS].sort(), [...SOURCE_SUITES].sort());
  for (const definition of REQUIRED_TEST_REPORTS.filter((entry) => entry.runner === 'playwright')) {
    assert.ok(validate(playwright(definition), definition).passed > 0);
  }
});

test('Vitest requires actual positive assertions and rejects skip/todo/failure/retry/summary corruption', () => {
  assert.equal(validate(vitest(), vitestDefinition).passed, 1);
  for (const mutate of [
    (report) => { report.numTotalTests = 0; report.testResults = []; },
    (report) => { report.numPendingTests = 1; },
    (report) => { report.numTodoTests = 1; },
    (report) => { report.numPassedTests = 0; },
    (report) => { report.testResults[0].assertionResults[0].status = 'pending'; },
    (report) => { report.testResults[0].assertionResults[0].retryCount = 1; },
  ]) { const report = vitest(); mutate(report); assert.throws(() => validate(report, vitestDefinition)); }
});

test('only five ci payment-form Vitest omissions are named nonexecuted cases, with same-report passing role guards', () => {
  assert.equal(VITEST_ROLE_OMISSIONS.length, 5);
  const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.suite === 'web-build');
  const omissions = VITEST_ROLE_OMISSIONS;
  const guards = omissions[0].guards;
  const report = { success: true, numTotalTests: omissions.length + guards.length, numPassedTests: guards.length,
    numFailedTests: 0, numPendingTests: omissions.length, testResults: [
      { name: '/web/tests/payment-form-dist.test.ts', assertionResults: omissions.map((entry) => ({ title: entry.title, ancestorTitles: entry.ancestors, status: 'pending', failureMessages: [] })) },
      { name: '/web/tests/payment-role-dist.test.ts', assertionResults: guards.map((entry) => ({ title: entry.title, ancestorTitles: entry.ancestors, status: 'passed', failureMessages: [] })) },
    ] };
  const options = { profile: SOURCE_REPORT_PROFILE };
  const summary = validateNativeTestReport(JSON.stringify(report), definition, options);
  assert.equal(summary.passed, guards.length);
  assert.equal(summary.skipped, 5);
  assert.deepEqual(summary.roleOmissions, omissions);
  const summaries = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => suite === definition.suite ? summary : ({ suite, runner, reportSha256: 'a'.repeat(64),
    total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
  assert.ok(validateReportSummaries(summaries, options));
  assert.throws(() => validateReportSummaries(summaries, { profile: 'preview-role' }), /unknown role/);
  assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, { profile: 'preview-role' }), /unapproved/);
  assert.throws(() => validateNativeTestReport(JSON.stringify(report), vitestDefinition, options), /unapproved/);
  for (const mutate of [
    (value) => { value.testResults[0].assertionResults[0].title = 'unknown payment skip'; },
    (value) => { value.testResults[0].assertionResults[0].ancestorTitles = ['other describe']; },
    (value) => { value.testResults[1].assertionResults.pop(); value.numTotalTests--; value.numPassedTests--; },
    (value) => { value.testResults[1].assertionResults[0].status = 'pending'; value.numPendingTests++; value.numPassedTests--; },
    (value) => { value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]); value.numTotalTests++; value.numPendingTests++; },
  ]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => validateNativeTestReport(JSON.stringify(changed), definition, options)); }
});

test('Playwright fails on missing project/file, zero tests, unexpected skip/fixme/flaky/retry', () => {
  const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.file === 'playwright-a11y-head.json');
  for (const mutate of [
    (report) => { report.suites = []; report.stats.expected = 0; },
    (report) => { report.suites[0].specs[0].tests.pop(); report.stats.expected--; },
    (report) => { report.suites[0].specs[0].tests[0].results[0].retry = 1; },
    (report) => { report.suites[0].specs[0].tests[0].status = 'flaky'; },
    (report) => { const entry = report.suites[0].specs[0].tests[0]; entry.status = 'skipped'; entry.expectedStatus = 'skipped'; entry.results[0].status = 'skipped'; report.stats.skipped++; report.stats.expected--; },
  ]) { const report = playwright(definition); mutate(report); assert.throws(() => validate(report, definition)); }
});

test('only exact viewport omissions with a passing named counterpart are accepted', () => {
  for (const omission of VIEWPORT_OMISSIONS) {
    const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.files.includes(omission.file));
    const report = playwright(definition);
    report.suites[0].specs.push({ file: omission.file, title: omission.title, tests: [{
      projectName: omission.project, expectedStatus: 'skipped', status: 'skipped', annotations: [{ type: 'skip' }],
      results: [{ status: 'skipped', retry: 0 }],
    }] });
    report.stats.skipped++;
    report.suites[0].specs.push({ file: omission.file, title: omission.counterpartTitle, tests: [{
      projectName: omission.counterpartProject, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0 }],
    }] });
    report.stats.expected++;
    assert.deepEqual(validate(report, definition).omissions, [omission]);
    report.suites[0].specs.at(-1).tests[0].results[0].retry = 1;
    assert.throws(() => validate(report, definition), /counterpart|non-pass/);
    report.suites[0].specs.at(-1).tests[0].results[0].retry = 0;
    report.suites[0].specs.at(-2).tests[0].annotations = [{ type: 'fixme', description: 'TD-4' }];
    assert.throws(() => validate(report, definition), /skipped/);
  }
});

test('only the 18 exact source-ci draft role omissions with the exact annotation are applicable', () => {
  assert.equal(ROLE_OMISSIONS.length, 18);
  for (const omission of ROLE_OMISSIONS) {
    const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.files.includes(omission.file));
    const report = playwright(definition);
    report.suites[0].specs.push({ file: omission.file, title: omission.title, tests: [{
      projectName: omission.project, expectedStatus: 'skipped', status: 'skipped',
      annotations: [{ type: 'skip', description: omission.annotation }], results: [{ status: 'skipped', retry: 0 }],
    }] });
    report.stats.skipped++;
    const options = { profile: SOURCE_REPORT_PROFILE };
    const summary = validateNativeTestReport(JSON.stringify(report), definition, options);
    assert.deepEqual(summary.roleOmissions, [omission]);
    assert.equal(summary.skipped, 1);
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition), /skipped/);
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, { profile: 'preview-role' }), /skipped/);
    const skipped = report.suites[0].specs.at(-1);
    skipped.tests[0].annotations[0].description = '404';
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /annotation/);
    skipped.tests[0].annotations[0].description = omission.annotation;
    skipped.tests[0].annotations[0].type = 'fixme';
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /skipped|annotation/);
    skipped.tests[0].annotations[0].type = 'skip';
    skipped.title = omission.title.replace('preview-b', 'home').replace('preview-c', 'preview-new').replace('preview-d', 'seminar');
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /skipped|annotation/);
  }
});

test('the seven accepted TD-52 mobile deviations stay visible and require the desktop PASS', () => {
  assert.equal(ACCEPTED_DEVIATIONS.length, 7);
  const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.files.includes('external-widgets.spec.ts'));
  for (const deviation of ACCEPTED_DEVIATIONS) {
    const report = playwright(definition);
    const skipped = { file: deviation.file, title: deviation.title, tests: [{ projectName: 'mobile', expectedStatus: 'skipped', status: 'skipped',
      annotations: [{ type: 'skip', description: deviation.annotation }], results: [{ status: 'skipped', retry: 0 }] }] };
    report.suites[0].specs.push(skipped);
    report.stats.skipped++;
    const options = { profile: SOURCE_REPORT_PROFILE };
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /counterpart/);
    report.suites[0].specs.push({ file: deviation.file, title: deviation.title, tests: [{
      projectName: 'desktop', expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0 }],
    }] });
    report.stats.expected++;
    const summary = validateNativeTestReport(JSON.stringify(report), definition, options);
    assert.deepEqual(summary.acceptedDeviations, [deviation]);
    assert.equal(summary.acceptedDeviations[0].acceptedOn, '2026-08-25');
    assert.equal(summary.skipped, 1);
    const summaries = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => suite === definition.suite ? summary : ({ suite, runner, reportSha256: 'a'.repeat(64),
      total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
    assert.ok(validateReportSummaries(summaries, options));
    assert.throws(() => validateReportSummaries(summaries, { profile: 'preview-role' }), /unaccepted/);
    skipped.tests[0].annotations[0].description = 'TD-52';
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /annotation/);
    skipped.tests[0].annotations[0].description = deviation.annotation;
    report.suites.push({ title: 'other describe', file: deviation.file, specs: [skipped] });
    report.stats.skipped++;
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, options), /duplicate applicability/);
  }
});

test('TD-4 and TD-5 fixme cases have no owner acceptance exemption', () => {
  const definition = REQUIRED_TEST_REPORTS.find((entry) => entry.file === 'playwright-a11y-head.json');
  for (const debt of ['TD-4', 'TD-5']) {
    const report = playwright(definition);
    report.suites[0].specs.push({ file: 'a11y.spec.ts', title: '/: header (TopNav) does not overflow horizontally at 2x root font-size', tests: [{
      projectName: 'desktop', expectedStatus: 'skipped', status: 'skipped', annotations: [{ type: 'fixme', description: debt }], results: [{ status: 'skipped', retry: 0 }],
    }] });
    report.stats.skipped++;
    assert.throws(() => validateNativeTestReport(JSON.stringify(report), definition, { profile: SOURCE_REPORT_PROFILE }), /skipped/);
  }
});

test('actual native Node TAP is accepted; zero/skipped/todo output is rejected', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-report-native-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'native.test.mjs');
  for (const [body, accepted] of [
    ["import {test} from 'node:test'; test('passes', () => {});", true],
    ["import {test} from 'node:test'; test.skip('not run', () => {});", false],
    ["import {test} from 'node:test'; test.todo('not implemented');", false],
    ['', false],
  ]) {
    writeFileSync(file, body);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env });
    if (accepted) assert.ok(validateNativeTestReport(result.stdout, tapDefinition).passed > 0);
    else assert.throws(() => validateNativeTestReport(result.stdout, tapDefinition));
  }
});

test('manifest aggregation requires every report, positive counts, exact inventory and valid omissions', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ikpk-report-inventory-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => collectTestReportSummaries(directory), /required report missing/);
  const summaries = REQUIRED_TEST_REPORTS.map(({ suite, runner }) => ({ suite, runner, reportSha256: 'a'.repeat(64),
    total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: 0, retried: 0, omissions: [], roleOmissions: [], acceptedDeviations: [] }));
  assert.equal(validateReportSummaries(summaries).length, REQUIRED_TEST_REPORTS.length);
  assert.throws(() => validateReportSummaries(summaries.slice(1)), /inventory incomplete/);
  for (const field of ['passed', 'failed', 'skipped', 'todo', 'flaky', 'retried']) {
    const changed = structuredClone(summaries); changed[0][field] = field === 'passed' ? 0 : 1;
    assert.throws(() => validateReportSummaries(changed));
  }
  const tap = 'TAP version 13\n# Subtest: a native scenario\nok 1 - a native scenario\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  for (const definition of REQUIRED_TEST_REPORTS) {
    const source = definition.runner === 'tap' ? tap : JSON.stringify(definition.runner === 'vitest' ? vitest() : playwright(definition));
    writeFileSync(join(directory, definition.file), source);
  }
  const collected = collectTestReportSummaries(directory);
  assert.equal(collected.length, REQUIRED_TEST_REPORTS.length);
  assert.ok(collected.every((entry) => entry.passed > 0 && /^[a-f0-9]{64}$/.test(entry.reportSha256)));
  writeFileSync(join(directory, vitestDefinition.file), '{}');
  assert.throws(() => collectTestReportSummaries(directory), /Vitest/);
});
