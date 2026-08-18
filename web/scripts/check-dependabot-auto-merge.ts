import { appendFileSync, readFileSync } from 'node:fs';
import {
  classifyPullRequest,
  evaluateHead,
  isAuthoritativeEvidenceRun,
  isTrustedPositiveEvidence,
  normalizeDependabotEcosystem,
  type DependencyUpdate,
  type StoredResult,
} from './lib/dependabot-auto-merge.ts';

const API = 'https://api.github.com';
const EVIDENCE_CHECK_NAME = 'Dependabot auto-merge / Provenance evidence';
const EVIDENCE_PRODUCER = 'github-actions/dependabot-auto-merge';

interface PullRequestEvent {
  action?: string;
  pull_request?: {
    number: number;
    head: { sha: string };
    base: { sha: string; ref: string };
    user: { login: string };
  };
}

interface ApiPullRequest {
  number: number;
  auto_merge: object | null;
  head: { sha: string };
  base: { sha: string; ref: string };
  user: { login: string };
}

interface MetadataDependency {
  dependencyName: string;
  dependencyType: string;
  updateType: string;
  directory: string;
  packageEcosystem: string;
}

interface SecurityRegistryFile {
  status?: string;
  runtime?: { packages?: unknown; lockfileNodes?: unknown };
  oracle?: { packages?: unknown; lockfileNodes?: unknown };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = requiredEnv('GITHUB_TOKEN');
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const result = await githubApi<{ data?: T; errors?: Array<{ message: string }> }>('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!result.data || result.errors?.length) {
    throw new Error(`GitHub GraphQL: ${result.errors?.map(({ message }) => message).join('; ') || 'missing data'}`);
  }
  return result.data;
}

function repository(): { owner: string; repo: string } {
  const [owner, repo, extra] = requiredEnv('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo || extra) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  return { owner, repo };
}

async function fileAt(ref: string, path: string): Promise<string> {
  const { owner, repo } = repository();
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const item = await githubApi<{ type: string; encoding: string; content: string }>(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  );
  if (item.type !== 'file' || item.encoding !== 'base64' || typeof item.content !== 'string') {
    throw new Error(`${path}@${ref} is not a base64 file`);
  }
  return Buffer.from(item.content.replaceAll('\n', ''), 'base64').toString('utf8');
}

async function allPullRequestFiles(number: number): Promise<string[]> {
  const { owner, repo } = repository();
  const result: string[] = [];
  for (let page = 1; ; page += 1) {
    const items = await githubApi<Array<{ filename?: string }>>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    for (const item of items) {
      if (typeof item.filename !== 'string') throw new Error('pull-request file has no filename');
      result.push(item.filename);
    }
    if (items.length < 100) return result;
  }
}

function metadataFromEnvironment(): MetadataDependency[] | null {
  const source = process.env.DEPENDABOT_METADATA_JSON;
  if (!source) return null;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((item) => item && typeof item === 'object')) return null;
    return parsed as MetadataDependency[];
  } catch {
    return null;
  }
}

function packageRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const match = /^(web|scripts|cms)\/(?:package|npm-shrinkwrap)(?:-lock)?\.json$/.exec(file);
    if (match) roots.add(match[1]);
  }
  return [...roots].sort();
}

function metadataUpdates(metadata: MetadataDependency[] | null, files: string[]): DependencyUpdate[] | null {
  if (!metadata) return null;
  const ecosystems = new Set(metadata.map(({ packageEcosystem }) => packageEcosystem));
  if (ecosystems.size !== 1) return null;
  const ecosystem = normalizeDependabotEcosystem([...ecosystems][0]);
  if (ecosystem === 'github-actions') {
    if (!files.every((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /(^|\/)action\.ya?ml$/.test(file))) {
      return null;
    }
    return metadata.map((item) => ({
      ecosystem: 'github-actions',
      dependencyName: item.dependencyName,
      updateType: item.updateType.replace('version-update:', ''),
      dependencySection: item.dependencyType,
    }));
  }
  if (ecosystem !== 'npm') return null;

  const roots = packageRoots(files);
  if (roots.length === 0 || !files.every((file) => /^(web|scripts|cms)\/(?:package|npm-shrinkwrap)(?:-lock)?\.json$/.test(file))) {
    return null;
  }
  return roots.flatMap((packageName) => metadata.map((item) => ({
    ecosystem: 'npm',
    packageName,
    dependencyName: item.dependencyName,
    updateType: item.updateType.replace('version-update:', ''),
    dependencySection: item.dependencyType,
  })));
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

async function securityRegistry(baseSha: string, headSha: string): Promise<{
  readable: boolean;
  consistent: boolean;
  directPackages: string[];
  lockfileNodes: string[];
  changedLockfileNodes: string[];
}> {
  try {
    const registry = JSON.parse(await fileAt(
      baseSha,
      'web/tests/fixtures/rich-content-safety/security-dependency-registry.json',
    )) as SecurityRegistryFile;
    const directPackages = [
      ...(strings(registry.runtime?.packages) ?? []),
      ...(strings(registry.oracle?.packages) ?? []),
    ];
    const lockfileNodes = [
      ...(strings(registry.runtime?.lockfileNodes) ?? []),
      ...(strings(registry.oracle?.lockfileNodes) ?? []),
    ];
    const baseLock = JSON.parse(await fileAt(baseSha, 'web/package-lock.json')) as { packages?: Record<string, unknown> };
    const headLock = JSON.parse(await fileAt(headSha, 'web/package-lock.json')) as { packages?: Record<string, unknown> };
    const baseNodes = baseLock.packages;
    const headNodes = headLock.packages;
    const unique = (items: string[]) => new Set(items).size === items.length;
    const packagesExist = directPackages.every((name) => Object.keys(baseNodes ?? {}).some((node) =>
      node === `node_modules/${name}` || node.endsWith(`/node_modules/${name}`)));
    const nodesExist = lockfileNodes.every((node) => Object.hasOwn(baseNodes ?? {}, node));
    const consistent = registry.status === 'implemented' &&
      directPackages.length > 0 && lockfileNodes.length > 0 &&
      unique(directPackages) && unique(lockfileNodes) && packagesExist && nodesExist && Boolean(headNodes);
    const changedLockfileNodes = consistent
      ? lockfileNodes.filter((node) => JSON.stringify(baseNodes?.[node]) !== JSON.stringify(headNodes?.[node]))
      : [];
    return { readable: true, consistent, directPackages, lockfileNodes, changedLockfileNodes };
  } catch {
    return { readable: false, consistent: false, directPackages: [], lockfileNodes: [], changedLockfileNodes: [] };
  }
}

async function signatureFor(sha: string): Promise<{
  valid: boolean;
  wasSignedByGitHub: boolean;
  signerLogin: string | null;
}> {
  const { owner, repo } = repository();
  const result = await graphql<{
    repository: { object: null | { signature: null | {
      isValid: boolean;
      wasSignedByGitHub: boolean;
      signer: null | { login: string };
    } } };
  }>(`query($owner: String!, $repo: String!, $sha: GitObjectID!) {
    repository(owner: $owner, name: $repo) {
      object(oid: $sha) {
        ... on Commit {
          signature { isValid wasSignedByGitHub signer { login } }
        }
      }
    }
  }`, { owner, repo, sha });
  const signature = result.repository.object?.signature;
  return {
    valid: signature?.isValid === true,
    wasSignedByGitHub: signature?.wasSignedByGitHub === true,
    signerLogin: signature?.signer?.login ?? null,
  };
}

function trustedPolicyShas(): string[] {
  const sha = requiredEnv('TRUSTED_POLICY_SHA');
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('TRUSTED_POLICY_SHA is malformed');
  return [sha];
}

async function hasPositiveEvidence(sha: string, pullRequestNumber: number): Promise<boolean> {
  const { owner, repo } = repository();
  const result = await githubApi<{ check_runs?: Array<{
    name?: string;
    conclusion?: string | null;
    status?: string;
    head_sha?: string;
    external_id?: string;
    app?: { slug?: string; id?: number };
  }> }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`);
  if (!Array.isArray(result.check_runs)) throw new Error('check-runs response is malformed');
  const candidates = result.check_runs.filter((run) =>
    run.status === 'completed' && run.conclusion === 'success' &&
    run.name === EVIDENCE_CHECK_NAME &&
    run.app?.slug === 'github-actions');
  const trusted = new Set(trustedPolicyShas());
  for (const candidate of candidates) {
    const detailsUrl = (candidate as typeof candidate & { details_url?: unknown }).details_url;
    if (typeof detailsUrl !== 'string') continue;
    const runId = /\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:\?|$)/.exec(detailsUrl)?.[1];
    if (!runId) continue;
    const run = await githubApi<{
      event?: string;
      head_sha?: string;
      path?: string;
      pull_requests?: Array<{ number?: number; head?: { sha?: string } }>;
      referenced_workflows?: Array<{ path?: string; sha?: string }>;
    }>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    const trustedReference = run.referenced_workflows?.find((workflow) =>
      workflow.path?.startsWith(`${owner}/${repo}/.github/workflows/dependabot-auto-merge-policy.yml@`) &&
      typeof workflow.sha === 'string');
    const expectedCaller = '.github/workflows/dependabot-auto-merge.yml';
    const callerWorkflowPath = run.path?.split('@')[0] ?? '';
    const reusablePolicyPath = trustedReference?.path?.split('@')[0]
      .replace(`${owner}/${repo}/`, '') ?? '';
    const externalId = `provenance:${sha}:${trustedReference?.sha ?? ''}`;
    const jobsResult = await githubApi<{ jobs?: Array<{
      name?: string;
      conclusion?: 'success' | 'failure' | 'cancelled' | null;
    }> }>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`);
    if (!Array.isArray(run.pull_requests) || !Array.isArray(jobsResult.jobs)) {
      throw new Error('authoritative workflow run response is malformed');
    }
    const authoritative = isAuthoritativeEvidenceRun({
      targetPullRequestNumber: pullRequestNumber,
      targetHeadSha: sha,
      provenanceJobName: 'Policy / Provenance evidence',
      run: {
        pullRequests: run.pull_requests.map((pullRequest) => ({
          number: pullRequest.number ?? -1,
          headSha: pullRequest.head?.sha ?? '',
        })),
      },
      jobs: jobsResult.jobs.map((job) => ({
        name: job.name ?? '',
        conclusion: job.conclusion ?? null,
      })),
    });
    if (run.event === 'pull_request_target' && trustedReference?.sha && authoritative &&
        isTrustedPositiveEvidence({
          sha: candidate.head_sha ?? '',
          name: candidate.name ?? '',
          status: candidate.status as 'completed',
          conclusion: candidate.conclusion as 'success',
          appSlug: candidate.app?.slug ?? '',
          appId: candidate.app?.id ?? -1,
          eventName: run.event,
          externalId: candidate.external_id ?? '',
          callerWorkflowPath,
          reusablePolicyPath,
          reusablePolicySha: trustedReference.sha,
        }, {
          sha,
          checkName: EVIDENCE_CHECK_NAME,
          appSlug: 'github-actions',
          appId: 15368,
          eventName: 'pull_request_target',
          externalId,
          callerWorkflowPath: expectedCaller,
          reusablePolicyPath: '.github/workflows/dependabot-auto-merge-policy.yml',
          reusablePolicySha: trustedReference.sha,
        }) && trusted.has(trustedReference.sha)) {
      return true;
    }
  }
  return false;
}

function actorKind(login: string): 'dependabot' | 'human' {
  return login === 'dependabot[bot]' ? 'dependabot' : 'human';
}

function output(name: string, value: string | boolean): void {
  const target = requiredEnv('GITHUB_OUTPUT');
  appendFileSync(target, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
}

async function main(): Promise<void> {
  const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as PullRequestEvent;
  if (!event.pull_request) throw new Error('pull_request payload is required');
  const { owner, repo } = repository();
  const current = await githubApi<ApiPullRequest>(`/repos/${owner}/${repo}/pulls/${event.pull_request.number}`);
  if (current.head.sha !== event.pull_request.head.sha) {
    throw new Error(`event head ${event.pull_request.head.sha} is stale; current head is ${current.head.sha}`);
  }

  const files = await allPullRequestFiles(current.number);
  const updates = metadataUpdates(metadataFromEnvironment(), files);
  const touchesWeb = packageRoots(files).includes('web');
  const registry = touchesWeb ? await securityRegistry(current.base.sha, current.head.sha) : undefined;
  const classification = classifyPullRequest({
    metadata: updates ? { updates } : null,
    securityRegistry: registry,
    changedLockfileNodes: registry?.changedLockfileNodes,
  });

  const action = event.action ?? '';
  const introducesHead = action === 'opened' || action === 'synchronize';
  const signature = await signatureFor(current.head.sha);
  const priorEvidence = introducesHead ? false : await hasPositiveEvidence(current.head.sha, current.number);
  const actorLogin = requiredEnv('GITHUB_ACTOR');
  const storedResults: StoredResult[] = priorEvidence ? [{
    sha: current.head.sha,
    kind: 'provenance',
    producer: EVIDENCE_PRODUCER,
    conclusion: 'positive',
  }] : [];

  const directOrigin = introducesHead && current.user.login === 'dependabot[bot]' &&
    signature.valid && signature.wasSignedByGitHub && actorKind(actorLogin) === 'dependabot';
  const originPositive = directOrigin || priorEvidence;
  const evaluation = evaluateHead({
    sha: current.head.sha,
    autoMergeEnabled: current.auto_merge !== null,
    classificationEligible: classification.eligible,
    prAuthor: current.user.login,
    signature,
    actor: originPositive ? { login: 'dependabot[bot]', kind: 'dependabot' } : { login: actorLogin, kind: 'human' },
    storedResults,
    expectedEvidenceProducer: EVIDENCE_PRODUCER,
  });
  const enable = current.user.login === 'dependabot[bot]' && classification.eligible &&
    originPositive && current.auto_merge === null;
  const disable = current.auto_merge !== null && (!classification.eligible || !originPositive);
  const reason = `${classification.reason}; ${evaluation.gate.reason}`;

  output('eligible', classification.eligible);
  output('origin-positive', originPositive);
  output('gate-ok', evaluation.gate.ok);
  output('record-evidence', introducesHead);
  output('enable-auto-merge', enable);
  output('disable-auto-merge', disable);
  output('auto-merge-enabled', current.auto_merge !== null);
  output('pr-number', current.number.toString());
  output('head-sha', current.head.sha);
  output('reason', reason);
  console.log(JSON.stringify({
    pullRequest: current.number,
    head: current.head.sha,
    action,
    classification,
    originPositive,
    gate: evaluation.gate,
    enable,
    disable,
  }, null, 2));
}

await main();
