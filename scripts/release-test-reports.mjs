/** Validate native runner output; no reports are synthesized from command exit codes. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const REPORT_POLICY_VERSION = 1;
export const NON_TEST_CHECKS = Object.freeze(['dependency-invariants', 'cms-build']);
const item = (suite, runner, file, files = [], projects = []) => ({ suite, runner, file, files, projects });
export const REQUIRED_TEST_REPORTS = Object.freeze([
  item('web-unit', 'vitest', 'web-unit-head.json'),
  item('web-render', 'vitest', 'web-render-head.json'),
  item('web-build', 'vitest', 'web-build-head.json'),
  item('web-demo-build', 'vitest', 'web-demo-head.json'),
  item('web-stand-build', 'vitest', 'web-stand-head.json'),
  item('scripts-unit', 'vitest', 'scripts-unit-head.json'),
  item('publication-transport', 'tap', 'publication-native.tap'),
  ...[
    ['smoke', 'site.spec.ts', ['desktop', 'mobile']],
    ['a11y', 'a11y.spec.ts', ['desktop', 'mobile']],
    ['catalog', 'article-catalog.spec.ts', ['desktop']],
    ['seminar', 'seminar-schedule.spec.ts', ['desktop']],
    ['footer', 'footer-social.spec.ts', ['desktop', 'footer-tablet', 'mobile']],
    ['schedule', 'schedule-month.spec.ts', ['desktop']],
    ['payment-preview', 'payment-form-demo.spec.ts', ['preview-role']],
    ['payment-stand', ['payment-form.spec.ts', 'payment-transport.spec.ts', 'payment-contour.spec.ts'], ['stand-role']],
    ['widgets', ['external-widgets.spec.ts', 'external-widgets-baseline-repeat.spec.ts'], ['desktop', 'mobile']],
    ['section', 'section-titles.spec.ts', ['desktop', 'mobile']],
    ['compat', 'compat.spec.ts', ['compat-chrome-desktop', 'compat-firefox-desktop', 'compat-safari-desktop',
      'compat-ios-iphone-se', 'compat-ios-iphone-14', 'compat-ios-ipad', 'compat-android-chrome']],
    ['visual', 'visual-baseline.spec.ts', ['desktop', 'mobile']],
  ].map(([name, files, projects]) => item(({
    smoke: 'e2e-smoke-desktop-mobile', a11y: 'e2e-a11y-desktop-mobile',
    catalog: 'e2e-catalog-desktop', seminar: 'e2e-seminar-desktop',
    footer: 'e2e-footer-desktop-tablet-mobile', schedule: 'e2e-schedule-month',
    widgets: 'e2e-widgets-probe-and-repeat', section: 'e2e-section-titles-desktop-mobile',
    compat: 'e2e-compat-seven-projects', visual: 'visual-darwin-desktop-mobile',
  })[name] ?? `e2e-${name}`, 'playwright', `playwright-${name}-head.json`, [].concat(files), projects)),
  item('cms-unit', 'tap', 'cms-unit.tap'),
  item('cms-to-site-isolated', 'tap', 'cms-e2e.tap'),
  item('provisioning-isolated-docker', 'vitest', 'provision-head.json'),
]);

// Exact viewport-only combinations, versioned with REPORT_POLICY_VERSION. Every
// omitted assertion needs its named passing counterpart in this same native report.
// fixme/TD debt and missing draft/content subjects are never allowed here.
export const VIEWPORT_OMISSIONS = Object.freeze([
  ...['items with a dropdown show a visible chevron', 'hovering an item with a dropdown reveals its links']
    .map((title) => ({ file: 'site.spec.ts', title, project: 'mobile', counterpartTitle: title, counterpartProject: 'desktop', reason: 'desktop-navigation-viewport' })),
  ...['щелчок вне меню закрывает его', 'Escape закрывает меню']
    .map((title) => ({ file: 'site.spec.ts', title, project: 'desktop', counterpartTitle: title, counterpartProject: 'mobile', reason: 'mobile-navigation-viewport' })),
  ...['compat-chrome-desktop', 'compat-firefox-desktop', 'compat-safari-desktop']
    .map((project) => ({ file: 'compat.spec.ts', title: 'мобильное меню закрывается щелчком вне себя', project,
      counterpartTitle: 'мобильное меню закрывается щелчком вне себя', counterpartProject: 'compat-ios-iphone-se', reason: 'mobile-navigation-viewport' })),
  { file: 'a11y.spec.ts', title: 'иконка отличает состояния (bar)', project: 'mobile',
    counterpartTitle: 'иконка отличает состояния (bar)', counterpartProject: 'desktop', reason: 'bar-control-viewport' },
  { file: 'a11y.spec.ts', title: 'иконка отличает состояния (drawer)', project: 'desktop',
    counterpartTitle: 'иконка отличает состояния (drawer)', counterpartProject: 'mobile', reason: 'drawer-control-viewport' },
]);

export class ReleaseReportError extends Error {
  constructor(message) { super(message); this.name = 'ReleaseReportError'; this.code = 'release-test-report-invalid'; }
}
const requireThat = (condition, detail) => { if (!condition) throw new ReleaseReportError(detail); };
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const filename = (path) => String(path).replaceAll('\\', '/').split('/').at(-1);
const positive = (summary) => {
  requireThat(number(summary.total) && summary.total > 0, `${summary.suite}: zero executed tests`);
  requireThat(number(summary.passed) && summary.passed > 0, `${summary.suite}: no passing tests`);
  for (const field of ['failed', 'todo', 'flaky', 'retried']) {
    requireThat(summary[field] === 0, `${summary.suite}: ${field} is not zero`);
  }
  requireThat(Array.isArray(summary.omissions), `${summary.suite}: omissions missing`);
  requireThat(summary.skipped === summary.omissions.length, `${summary.suite}: unapproved skipped tests`);
  requireThat(summary.total === summary.passed + summary.omissions.length, `${summary.suite}: inconsistent executed totals`);
};

function vitest(report, definition) {
  requireThat(report.success === true && Array.isArray(report.testResults), `${definition.suite}: invalid Vitest report`);
  const tests = report.testResults.flatMap((file) => file.assertionResults ?? []);
  requireThat(tests.length === report.numTotalTests && tests.length > 0, `${definition.suite}: Vitest test inventory mismatch`);
  requireThat(report.numPassedTests === tests.length && report.numFailedTests === 0 && report.numPendingTests === 0 && (report.numTodoTests ?? 0) === 0,
    `${definition.suite}: Vitest contains failed/skipped/todo tests`);
  for (const test of tests) {
    requireThat(test.status === 'passed' && (test.failureMessages ?? []).length === 0, `${definition.suite}: Vitest non-pass`);
    requireThat((test.retryCount ?? test.meta?.retryCount ?? 0) === 0 && (test.retryReasons ?? []).length === 0, `${definition.suite}: Vitest retry`);
  }
  return { total: tests.length, passed: tests.length, omissions: [] };
}

function playwright(report, definition) {
  requireThat(Array.isArray(report.suites) && report.stats && (report.errors ?? []).length === 0, `${definition.suite}: invalid Playwright report`);
  const tests = [];
  const visit = (suite, parents = []) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      tests.push({ ...test, title: spec.title, scope: [...parents, suite.title].join(' > '), file: filename(spec.file ?? suite.file) });
    }
    for (const child of suite.suites ?? []) visit(child, [...parents, suite.title]);
  };
  for (const suite of report.suites) visit(suite);
  const passed = (test) => test.expectedStatus === 'passed' && test.status === 'expected' &&
    test.results?.length === 1 && test.results[0].status === 'passed' && (test.results[0].retry ?? 0) === 0;
  const omissions = [];
  const identities = new Set();
  for (const test of tests) {
    const identity = `${test.file}\0${test.scope}\0${test.title}\0${test.projectName}`;
    requireThat(!identities.has(identity), `${definition.suite}: duplicate test identity`);
    identities.add(identity);
    if (passed(test)) continue;
    const omission = VIEWPORT_OMISSIONS.find((entry) => entry.file === test.file && entry.title === test.title && entry.project === test.projectName);
    requireThat(omission && test.status === 'skipped' && test.expectedStatus === 'skipped' &&
      test.results?.length === 1 && test.results[0].status === 'skipped' && (test.results[0].retry ?? 0) === 0 &&
      !(test.annotations ?? []).some((entry) => entry.type === 'fixme'), `${definition.suite}: skipped/flaky/non-pass ${test.file}: ${test.title} (${test.projectName})`);
    requireThat(tests.some((candidate) => candidate.file === omission.file && candidate.title === omission.counterpartTitle &&
      candidate.projectName === omission.counterpartProject && passed(candidate)), `${definition.suite}: viewport omission has no passing counterpart`);
    omissions.push({ ...omission });
  }
  const expected = report.stats.expected;
  requireThat(report.stats.unexpected === 0 && report.stats.flaky === 0 && report.stats.skipped === omissions.length && expected === tests.length - omissions.length,
    `${definition.suite}: Playwright summary mismatch or failure`);
  for (const file of definition.files) for (const project of definition.projects) {
    requireThat(tests.some((test) => test.file === file && test.projectName === project && passed(test)), `${definition.suite}: missing passing file/project ${file}/${project}`);
  }
  return { total: tests.length, passed: expected, omissions };
}

function tap(source, definition) {
  const counters = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...source.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    requireThat(matches.length === 1, `${definition.suite}: TAP ${key} summary missing or repeated`);
    counters[key] = Number(matches[0][1]);
  }
  requireThat(/^TAP version 13\r?$/m.test(source) && counters.tests > 0 && counters.pass === counters.tests &&
    counters.fail === 0 && counters.cancelled === 0 && counters.skipped === 0 && counters.todo === 0 &&
    !/^\s*not ok\b/m.test(source) && !/^\s*(?:not )?ok\b.*#\s*(?:SKIP|TODO)\b/im.test(source), `${definition.suite}: TAP non-pass or zero tests`);
  const results = [...source.matchAll(/^\s*ok\s+\d+\s*-\s*(.+)\r?$/gm)].map((match) => match[1]);
  requireThat(results.length >= counters.pass, `${definition.suite}: TAP results missing`);
  // Node treats an empty test file as a successful file-level test. That is not
  // positive execution of declared cases and must not satisfy a release suite.
  requireThat(!results.some((title) => /(?:^|[\/\\])[^\/\\]*\.(?:[cm]?js|tsx?)$/.test(title)), `${definition.suite}: TAP file passed without named cases`);
  return { total: counters.tests, passed: counters.pass, omissions: [] };
}

export function validateNativeTestReport(source, definition) {
  let counts;
  if (definition.runner === 'tap') counts = tap(source, definition);
  else {
    let report;
    try { report = JSON.parse(source); } catch { throw new ReleaseReportError(`${definition.suite}: malformed JSON report`); }
    counts = definition.runner === 'vitest' ? vitest(report, definition) : playwright(report, definition);
  }
  const summary = { suite: definition.suite, runner: definition.runner,
    reportSha256: createHash('sha256').update(source).digest('hex'),
    ...counts, failed: 0, skipped: counts.omissions.length, todo: 0, flaky: 0, retried: 0 };
  positive(summary);
  return summary;
}

export function validateReportSummaries(summaries) {
  requireThat(Array.isArray(summaries) && summaries.length === REQUIRED_TEST_REPORTS.length, 'release report inventory incomplete');
  return REQUIRED_TEST_REPORTS.map((definition) => {
    const matching = summaries.filter((entry) => entry?.suite === definition.suite);
    requireThat(matching.length === 1, `${definition.suite}: report missing or duplicated`);
    const summary = matching[0];
    requireThat(summary.runner === definition.runner && /^[0-9a-f]{64}$/.test(summary.reportSha256 ?? ''), `${definition.suite}: invalid report identity`);
    positive(summary);
    for (const omission of summary.omissions) requireThat(definition.runner === 'playwright' && definition.files.includes(omission.file) && definition.projects.includes(omission.project) &&
      VIEWPORT_OMISSIONS.some((entry) => JSON.stringify(entry) === JSON.stringify(omission)), `${definition.suite}: unknown omission`);
    return { ...summary, omissions: summary.omissions.map((entry) => ({ ...entry })) };
  });
}

export function collectTestReportSummaries(directory) {
  return validateReportSummaries(REQUIRED_TEST_REPORTS.map((definition) => {
    let source;
    try { source = readFileSync(join(directory, definition.file), 'utf8'); }
    catch { throw new ReleaseReportError(`${definition.suite}: required report missing`); }
    return validateNativeTestReport(source, definition);
  }));
}
