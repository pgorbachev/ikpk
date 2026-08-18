export const SIGNAL_SCHEMA = 'dependabot-auto-merge-signal/v1';
export const SIGNAL_ARTIFACT = 'dependabot-auto-merge-signal';
export const SIGNAL_FILE = 'dependabot-auto-merge-signal.json';

export type AuthenticationProblem =
  | 'source-run-id'
  | 'source-run-attempt'
  | 'source-workflow-path'
  | 'source-repository'
  | 'source-event'
  | 'source-action'
  | 'source-conclusion'
  | 'source-actor'
  | 'source-pull-request'
  | 'source-head'
  | 'single-artifact'
  | 'artifact-digest'
  | 'archive-members'
  | 'artifact-schema';

/**
 * Static seam for the trusted dispatcher. The shell still has API-level tests in
 * the producer suite; this small validator makes every security clause
 * independently mutable instead of accepting one large substring as evidence.
 */
export function authenticationProblems(source: string): AuthenticationProblem[] {
  const requirements: Array<[AuthenticationProblem, RegExp]> = [
    ['source-run-id', /workflow_run\.id|SOURCE_RUN_ID/],
    ['source-run-attempt', /workflow_run\.run_attempt|SOURCE_RUN_ATTEMPT/],
    ['source-workflow-path', /\.path\b|SOURCE_WORKFLOW_PATH/],
    ['source-repository', /repository\.full_name|SOURCE_REPOSITORY/],
    ['source-event', /pull_request_target/],
    ['source-action', /SOURCE_ACTION|\.action\b/],
    ['source-conclusion', /conclusion[^\n]*(?:success|SOURCE_CONCLUSION)|SOURCE_CONCLUSION/],
    ['source-actor', /actor\.login|SOURCE_ACTOR/],
    ['source-pull-request', /pull_requests|SOURCE_PR_NUMBER/],
    ['source-head', /head_sha|SOURCE_HEAD_SHA/],
    ['single-artifact', /artifacts[^\n]*(?:length|total_count)|ARTIFACT_COUNT/],
    ['artifact-digest', /digest[^\n]*(?:sha256|sha256sum)|ARTIFACT_DIGEST/],
    ['archive-members', /zipinfo|unzip[^\n]*(?:-Z|-l)|ARCHIVE_MEMBERS/],
    ['artifact-schema', new RegExp(SIGNAL_SCHEMA.replace('/', '\\/'))],
  ];
  return requirements.flatMap(([problem, pattern]) => pattern.test(source) ? [] : [problem]);
}
