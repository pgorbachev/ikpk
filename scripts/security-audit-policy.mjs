import { readFileSync } from 'node:fs';

const severityLevels = ['critical', 'high', 'moderate', 'low', 'info'];

export function parseAuditReport(reportText) {
  let report;
  try {
    report = JSON.parse(reportText);
  } catch (error) {
    throw new Error(`npm audit did not produce valid JSON: ${error.message}`, { cause: error });
  }

  if (report?.error) {
    throw new Error(`npm audit reported an error: ${report.error.summary ?? report.error.code ?? 'unknown error'}`);
  }
  if (report?.auditReportVersion !== 2) {
    throw new Error('npm audit report has an unsupported or missing auditReportVersion');
  }
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw new Error('npm audit report is missing metadata.vulnerabilities');
  }
  for (const level of severityLevels) {
    if (!Number.isSafeInteger(vulnerabilities[level]) || vulnerabilities[level] < 0) {
      throw new Error(`npm audit report has invalid ${level} count`);
    }
  }
  if (!Number.isSafeInteger(vulnerabilities.total) || vulnerabilities.total < 0) {
    throw new Error('npm audit report is missing a valid total count');
  }
  const computedTotal = severityLevels.reduce((sum, level) => sum + vulnerabilities[level], 0);
  if (computedTotal !== vulnerabilities.total) {
    throw new Error(`npm audit total ${vulnerabilities.total} does not match severity counts ${computedTotal}`);
  }

  const details = report.vulnerabilities;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error('npm audit report is missing its vulnerabilities detail map');
  }
  const detailCounts = Object.fromEntries(severityLevels.map((level) => [level, 0]));
  for (const [name, entry] of Object.entries(details)) {
    if (!entry || typeof entry !== 'object' || entry.name !== name || !severityLevels.includes(entry.severity)) {
      throw new Error(`npm audit report has malformed vulnerability entry ${name}`);
    }
    detailCounts[entry.severity] += 1;
  }
  for (const level of severityLevels) {
    if (detailCounts[level] !== vulnerabilities[level]) {
      throw new Error(`npm audit ${level} detail count ${detailCounts[level]} does not match metadata count ${vulnerabilities[level]}`);
    }
  }

  const dependencies = report?.metadata?.dependencies;
  const dependencyKinds = ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'];
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('npm audit report is missing metadata.dependencies');
  }
  for (const kind of dependencyKinds) {
    if (!Number.isSafeInteger(dependencies[kind]) || dependencies[kind] < 0) {
      throw new Error(`npm audit report has invalid ${kind} dependency count`);
    }
  }
  if (dependencies.total === 0) {
    throw new Error('npm audit report has an empty dependency inventory');
  }
  return vulnerabilities;
}

export function auditResult(reportText, npmStatus) {
  if (npmStatus !== 0 && npmStatus !== 1) {
    throw new Error('npm audit exit status must be 0 or 1');
  }
  const counts = parseAuditReport(reportText);
  const blockingFindings = counts.high + counts.critical;

  // npm audit --audit-level=high must return zero exactly when the report has
  // no high or critical findings. A mismatch indicates a broken measurement.
  if (npmStatus === 0 && blockingFindings > 0) {
    throw new Error('npm audit returned success despite high or critical findings');
  }
  if (npmStatus !== 0 && blockingFindings === 0) {
    throw new Error(`npm audit failed with exit ${npmStatus} and no high or critical findings`);
  }
  return { counts, passed: npmStatus === 0 };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const reportText = readFileSync(process.argv[2], 'utf8');
    const npmStatus = Number(process.argv[3]);
    const { counts, passed } = auditResult(reportText, npmStatus);
    const status = passed ? 'passed' : 'blocked by high/critical findings';
    console.log(`npm audit ${status}: high=${counts.high} critical=${counts.critical} total=${counts.total}`);
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Security audit measurement failed: ${error.message}`);
    process.exitCode = 1;
  }
}
