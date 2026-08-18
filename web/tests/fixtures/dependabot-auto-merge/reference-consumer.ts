// Test-only source control for exact-attempt evidence lookup assertions.
declare function githubApi(path: string): Promise<unknown>;
const EVIDENCE_CHECK_NAME = 'Dependabot auto-merge / Provenance evidence';

export async function jobsForAttempt(runId: number, runAttempt: number, page: number) {
  return githubApi(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
}

export async function evidenceChecks(sha: string, page: number) {
  return githubApi(
    `commits/${sha}/check-runs?check_name=${encodeURIComponent(EVIDENCE_CHECK_NAME)}&app_id=15368&page=${page}`,
  );
}
