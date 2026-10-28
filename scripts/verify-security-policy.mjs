const expectedProducers = [
  'SECRET_SCAN',
  'RUNTIME_AUDITS',
  'CMS_RUNTIME_AUDIT',
  'FULL_AUDITS',
  'CODEQL',
  'POLICY_TESTS',
];

export function evaluateSecurityPolicy(results) {
  const missing = expectedProducers.filter((producer) => !(producer in results));
  const unsuccessful = expectedProducers.filter((producer) => results[producer] !== 'success');
  return { passed: missing.length === 0 && unsuccessful.length === 0, missing, unsuccessful };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const outcome = evaluateSecurityPolicy(process.env);
  if (!outcome.passed) {
    console.error(`Security policy failed. Missing: ${outcome.missing.join(', ') || 'none'}; not successful: ${outcome.unsuccessful.join(', ') || 'none'}`);
    process.exitCode = 1;
  } else {
    console.log('All expected security producers completed successfully.');
  }
}
