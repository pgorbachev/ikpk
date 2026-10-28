const severities = ['critical', 'high', 'moderate', 'low', 'info'];
const blocking = new Set(['high', 'critical']);
const recordFields = new Set([
  'component', 'package', 'advisory', 'lock_nodes', 'observed_report_severity',
  'accepted_max_severity', 'owner', 'decision', 'decision_reference', 'expires_at',
  'reason', 'applicability', 'mitigation', 'source_evidence',
]);
const evidenceFields = new Set([
  'repository', 'revision', 'workflow_run_id', 'full_report_artifact_id',
  'runtime_report_artifact_id', 'runtime_report_contains_package',
  'full_report_affected_entries', 'reported_ranges', 'limitation',
  'package_lock', 'locked_versions', 'official_sources',
  'published_package', 'published_packages',
]);
const ghsaPattern = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const componentNames = new Set(['web', 'cms', 'scripts', 'payments']);
const packagePattern = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label, pattern) {
  if (typeof value !== 'string' || value.trim() === '' || (pattern && !pattern.test(value))) {
    throw new Error('security exception has invalid ' + label);
  }
}

function sameNodePaths(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const paths = new Set(expected.map((node) => node.path));
  return paths.size === expected.length && new Set(actual).size === actual.length
    && actual.every((path) => paths.has(path));
}

function validatePolicy(policy, lockfile, component, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('security exception matcher requires a valid evaluation time');
  }
  if (!isRecord(policy) || policy.schema_version !== 1 || !Array.isArray(policy.exceptions)) {
    throw new Error('security exceptions must have schema_version 1 and an exceptions array');
  }
  if (Object.keys(policy).some((key) => key !== 'schema_version' && key !== 'exceptions')) {
    throw new Error('security exceptions have an unknown top-level field');
  }
  const records = new Map();
  for (const exception of policy.exceptions) {
    if (!isRecord(exception)) throw new Error('security exception must be an object');
    for (const key of Object.keys(exception)) {
      if (!recordFields.has(key)) throw new Error('security exception has unknown field ' + key);
    }
    for (const key of recordFields) {
      if (!(key in exception)) throw new Error('security exception is missing ' + key);
    }
    requireText(exception.component, 'component');
    if (!componentNames.has(exception.component)) throw new Error('security exception has unknown component');
    requireText(exception.package, 'package', packagePattern);
    requireText(exception.advisory, 'advisory', ghsaPattern);
    if (exception.observed_report_severity !== 'high' || exception.accepted_max_severity !== 'high') {
      throw new Error('security exception severity must be observed and capped at high');
    }
    requireText(exception.owner, 'owner');
    if (exception.decision !== 'PENDING' && exception.decision !== 'APPROVED') {
      throw new Error('security exception has invalid decision');
    }
    if (exception.decision === 'APPROVED') requireText(exception.decision_reference, 'decision_reference');
    else if (exception.decision_reference !== null) throw new Error('pending exception must have a null decision reference');
    for (const field of ['reason', 'applicability', 'mitigation']) requireText(exception[field], field);

    const expiryText = exception.expires_at;
    if (typeof expiryText !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiryText)) {
      throw new Error('security exception has invalid UTC expiry');
    }
    const expiry = Date.parse(expiryText);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 19) + 'Z' !== expiryText) {
      throw new Error('security exception has invalid UTC expiry');
    }
    if (exception.component === component && now.getTime() >= expiry) {
      throw new Error('security exception ' + exception.advisory + ' is expired; rerun CI after expiry to enforce');
    }

    if (!Array.isArray(exception.lock_nodes) || exception.lock_nodes.length === 0) {
      throw new Error('security exception must bind exact lock nodes');
    }
    const nodePaths = new Set();
    for (const node of exception.lock_nodes) {
      if (!isRecord(node) || Object.keys(node).length !== 2 || !('path' in node) || !('version' in node)) {
        throw new Error('security exception has malformed lock node');
      }
      requireText(node.path, 'lock node path', /^node_modules\/(?!.*(?:^|\/)\.\.?\/)(?!.*\*)[^\s]+$/);
      if (!(node.path === 'node_modules/' + exception.package || node.path.endsWith('/node_modules/' + exception.package))) {
        throw new Error('security exception lock node path does not match package');
      }
      requireText(node.version, 'lock node version', versionPattern);
      if (nodePaths.has(node.path)) throw new Error('security exception repeats a lock node');
      nodePaths.add(node.path);
      if (exception.component === component && lockfile.packages?.[node.path]?.version !== node.version) {
        throw new Error('security exception lock node version does not match ' + node.path);
      }
    }

    const evidence = exception.source_evidence;
    if (!isRecord(evidence)) throw new Error('security exception has malformed source_evidence');
    for (const key of Object.keys(evidence)) {
      if (!evidenceFields.has(key)) throw new Error('security exception has unknown evidence field ' + key);
    }
    for (const field of ['repository', 'revision', 'limitation']) requireText(evidence[field], 'source_evidence.' + field);
    if (!/^[0-9a-f]{40}$/.test(evidence.revision)) throw new Error('security exception has invalid evidence revision');
    for (const field of ['workflow_run_id', 'full_report_artifact_id', 'runtime_report_artifact_id']) {
      if (!Number.isSafeInteger(evidence[field]) || evidence[field] < 1) {
        throw new Error('security exception has invalid source_evidence.' + field);
      }
    }
    if (typeof evidence.runtime_report_contains_package !== 'boolean') {
      throw new Error('security exception has invalid runtime report evidence');
    }
    for (const field of ['full_report_affected_entries', 'reported_ranges']) {
      if (!Array.isArray(evidence[field]) || evidence[field].length === 0
        || evidence[field].some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new Error('security exception has invalid source_evidence.' + field);
      }
    }
    if (exception.component === component && evidence.package_lock !== component + '/package-lock.json') {
      throw new Error('security exception references a different component lockfile');
    }
    if (evidence.locked_versions && JSON.stringify(evidence.locked_versions) !== JSON.stringify(exception.lock_nodes)) {
      throw new Error('security exception has inconsistent locked_versions evidence');
    }
    if (evidence.official_sources !== undefined
      && (!Array.isArray(evidence.official_sources) || evidence.official_sources.some((item) => typeof item !== 'string' || !item.startsWith('https://')))) {
      throw new Error('security exception has invalid official_sources');
    }

    const key = exception.component + '\0' + exception.package + '\0' + exception.advisory;
    if (records.has(key)) throw new Error('duplicate security exception ' + exception.advisory);
    records.set(key, exception);
  }
  return records;
}

function validateAuditGraph(report) {
  const vulnerabilities = report.vulnerabilities;
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isRecord(entry) || !severities.includes(entry.severity) || !Array.isArray(entry.via)) {
      throw new Error('npm audit report has malformed via graph entry ' + name);
    }
    for (const cause of entry.via) {
      let causeSeverity;
      if (typeof cause === 'string') {
        if (!Object.hasOwn(vulnerabilities, cause)) {
          throw new Error('npm audit via graph has unresolved package reference ' + cause);
        }
        const child = vulnerabilities[cause];
        if (!isRecord(child) || !severities.includes(child.severity) || !Array.isArray(child.via)) {
          throw new Error('npm audit via graph references malformed package ' + cause);
        }
        causeSeverity = child.severity;
      } else {
        if (!isRecord(cause) || !severities.includes(cause.severity)) {
          throw new Error('npm audit via graph has malformed advisory cause in ' + name);
        }
        causeSeverity = cause.severity;
      }
      // npm may summarize low/moderate differences by package. Never allow a
      // high/critical cause to disappear under a nonblocking or weaker summary.
      if (blocking.has(causeSeverity)
        && (!blocking.has(entry.severity) || severities.indexOf(entry.severity) > severities.indexOf(causeSeverity))) {
        throw new Error('npm audit via graph understates blocking severity at ' + name);
      }
    }
  }
}

function approvedDirectAdvisory(component, packageName, ghsa, entry, directSeverity, records) {
  const exception = records.get(component + '\0' + packageName + '\0' + ghsa);
  return Boolean(exception && exception.decision === 'APPROVED'
    && exception.accepted_max_severity === 'high'
    && directSeverity === 'high'
    && entry.severity === 'high'
    && sameNodePaths(entry.nodes, exception.lock_nodes));
}

export function toleratedBlockingEntries(report, component, records) {
  const memo = new Map();
  function isTolerated(name, visiting = new Set()) {
    if (memo.has(name)) return memo.get(name);
    if (!Object.hasOwn(report.vulnerabilities, name)) return false;
    const entry = report.vulnerabilities[name];
    if (!entry || entry.severity !== 'high' || !Array.isArray(entry.via) || visiting.has(name)) return false;
    const next = new Set(visiting).add(name);
    let sawBlockingCause = false;
    for (const cause of entry.via) {
      if (typeof cause === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, cause)) return false;
        const child = report.vulnerabilities[cause];
        if (!child || !severities.includes(child.severity)) return false;
        if (blocking.has(child.severity)) {
          sawBlockingCause = true;
          if (!isTolerated(cause, next)) return false;
        }
        continue;
      }
      if (!isRecord(cause) || !severities.includes(cause.severity)) return false;
      if (!blocking.has(cause.severity)) continue;
      sawBlockingCause = true;
      const ghsa = typeof cause.url === 'string'
        ? cause.url.match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/)?.[1]
        : undefined;
      if (!ghsa || !approvedDirectAdvisory(component, entry.name, ghsa, entry, cause.severity, records)) return false;
    }
    const result = sawBlockingCause;
    memo.set(name, result);
    return result;
  }

  const toleratedNames = new Set();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (blocking.has(entry.severity) && isTolerated(name)) toleratedNames.add(name);
  }
  return toleratedNames;
}

export function matchSecurityExceptions(report, component, lockfile, policy, now = new Date()) {
  const records = validatePolicy(policy, lockfile, component, now);
  validateAuditGraph(report);
  const tolerated = toleratedBlockingEntries(report, component, records);
  for (const exception of records.values()) {
    if (exception.component !== component) continue;
    const entry = report.vulnerabilities[exception.package];
    const matchingCause = entry?.via?.find((cause) => isRecord(cause)
      && cause.url === 'https://github.com/advisories/' + exception.advisory);
    if (!matchingCause || !sameNodePaths(entry.nodes, exception.lock_nodes)) {
      throw new Error('security exception ' + exception.advisory + ' does not match this audit report');
    }
    if (exception.decision === 'APPROVED'
      && !approvedDirectAdvisory(component, exception.package, exception.advisory, entry, matchingCause.severity, records)) {
      throw new Error('approved security exception ' + exception.advisory + ' did not match severity and node scope');
    }
  }
  return tolerated;
}
