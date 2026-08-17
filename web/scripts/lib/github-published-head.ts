import type { PublishedHeadInput } from './dependency-update-gates';

interface GitHubCommit {
  sha?: unknown;
}

interface GitHubWorkflowRun {
  head_sha?: unknown;
  event?: unknown;
  created_at?: unknown;
}

interface GitHubWorkflowRuns {
  workflow_runs?: unknown;
}

interface GitHubDeployment {
  id?: unknown;
  sha?: unknown;
}

interface GitHubDeploymentStatus {
  state?: unknown;
  created_at?: unknown;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function githubJson<T>(url: string, token: string, fetchImpl: Fetch): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ikpk-published-head-monitor',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return await response.json() as T;
}

function latestStatus(statuses: GitHubDeploymentStatus[]): GitHubDeploymentStatus {
  const valid = statuses.filter((status): status is GitHubDeploymentStatus & { created_at: string } =>
    typeof status.created_at === 'string' && !Number.isNaN(Date.parse(status.created_at)),
  );
  if (valid.length !== statuses.length || valid.length === 0) {
    throw new Error('GitHub deployment statuses response has no complete current status');
  }
  return valid.reduce((latest, status) =>
    Date.parse(status.created_at) > Date.parse(latest.created_at) ? status : latest,
  );
}

export async function resolvePublishedHeadInputFromGitHub(input: {
  api: string;
  repository: string;
  token: string;
  maxLagMs: number;
  fetch?: Fetch;
  now?: string;
}): Promise<PublishedHeadInput> {
  const fetchImpl = input.fetch ?? fetch;
  const commit = await githubJson<GitHubCommit>(
    `${input.api}/repos/${input.repository}/commits/main`, input.token, fetchImpl,
  );
  if (typeof commit.sha !== 'string') throw new Error('GitHub main commit response has no SHA');

  const runs = await githubJson<GitHubWorkflowRuns>(
    `${input.api}/repos/${input.repository}/actions/workflows/test.yml/runs?branch=main&event=push&per_page=100`,
    input.token,
    fetchImpl,
  );
  if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub workflow runs response is malformed');
  const matchingRuns = (runs.workflow_runs as GitHubWorkflowRun[]).filter((run) =>
    run.head_sha === commit.sha && run.event === 'push' &&
    typeof run.created_at === 'string' && !Number.isNaN(Date.parse(run.created_at)),
  ) as Array<GitHubWorkflowRun & { created_at: string }>;
  if (matchingRuns.length === 0) throw new Error(`GitHub has no main push workflow run for ${commit.sha}`);
  const appearedAt = matchingRuns.reduce((latest, run) =>
    Date.parse(run.created_at) > Date.parse(latest.created_at) ? run : latest,
  ).created_at;

  const deployments = await githubJson<GitHubDeployment[]>(
    `${input.api}/repos/${input.repository}/deployments?sha=${encodeURIComponent(commit.sha)}&environment=github-pages&per_page=100`,
    input.token,
    fetchImpl,
  );
  if (!Array.isArray(deployments)) throw new Error('GitHub deployments response is malformed');

  let publishedSha: string | null = null;
  for (const deployment of deployments) {
    if (deployment.sha !== commit.sha || (!Number.isInteger(deployment.id) && typeof deployment.id !== 'string')) {
      continue;
    }
    const statuses = await githubJson<GitHubDeploymentStatus[]>(
      `${input.api}/repos/${input.repository}/deployments/${deployment.id}/statuses?per_page=100`,
      input.token,
      fetchImpl,
    );
    if (!Array.isArray(statuses)) throw new Error('GitHub deployment statuses response is malformed');
    if (latestStatus(statuses).state === 'success') {
      publishedSha = commit.sha;
      break;
    }
  }

  return {
    mainHeadSha: commit.sha,
    mainHeadCreatedAt: appearedAt,
    publishedSha,
    now: input.now ?? new Date().toISOString(),
    maxLagMs: input.maxLagMs,
  };
}
