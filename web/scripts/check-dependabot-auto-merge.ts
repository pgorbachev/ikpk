import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyPullRequest,
  evaluateHead,
  isAuthoritativeEvidenceRun,
  isTrustedPositiveEvidence,
  normalizeDependabotEcosystem,
  type DependencyUpdate,
  type HeadEvaluation,
  type HeadEvaluationInput,
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

interface PolicyEvent {
  action: string;
  actor: string;
  pullRequestNumber: number;
  headSha: string;
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

interface CompareResult {
  status?: string;
  merge_base_commit?: { sha?: string };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function policyEvent(): PolicyEvent {
  const action = process.env.POLICY_EVENT_ACTION;
  const actor = process.env.POLICY_EVENT_ACTOR;
  const number = process.env.POLICY_PR_NUMBER;
  const headSha = process.env.POLICY_EVENT_HEAD_SHA;
  if (action || actor || number || headSha) {
    if (!action || !actor || !number || !headSha) throw new Error('policy event inputs are incomplete');
    if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('POLICY_EVENT_HEAD_SHA is malformed');
    return {
      action,
      actor,
      pullRequestNumber: positiveInteger('POLICY_PR_NUMBER', number),
      headSha,
    };
  }

  const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as PullRequestEvent;
  if (!event.pull_request) throw new Error('pull_request payload is required');
  return {
    action: event.action ?? '',
    actor: requiredEnv('GITHUB_ACTOR'),
    pullRequestNumber: event.pull_request.number,
    headSha: event.pull_request.head.sha,
  };
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
  const encoded = process.env.DEPENDABOT_METADATA_JSON_BASE64;
  const source = encoded
    ? Buffer.from(encoded, 'base64').toString('utf8')
    : process.env.DEPENDABOT_METADATA_JSON;
  if (!source) return null;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((item) => item && typeof item === 'object' &&
      ['dependencyName', 'updateType', 'packageEcosystem'].every((key) =>
        typeof item[key] === 'string' && item[key].trim().length > 0))) return null;
    return parsed as MetadataDependency[];
  } catch {
    return null;
  }
}

function packageRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const match = /^(web|scripts|cms|payments)\/(?:package|npm-shrinkwrap)(?:-lock)?\.json$/.exec(file);
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
  if (roots.length === 0 || !files.every((file) => /^(web|scripts|cms|payments)\/(?:package|npm-shrinkwrap)(?:-lock)?\.json$/.test(file))) {
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
  type EvidenceCheckRun = {
    name?: string;
    conclusion?: string | null;
    status?: string;
    head_sha?: string;
    external_id?: string;
    details_url?: string | null;
    app?: { slug?: string; id?: number };
  };
  const checkRuns: EvidenceCheckRun[] = [];
  for (let page = 1; ; page += 1) {
    const result = await githubApi<{ check_runs?: EvidenceCheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?filter=all` +
      `&check_name=${encodeURIComponent(EVIDENCE_CHECK_NAME)}&app_id=15368&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.check_runs)) throw new Error('check-runs response is malformed');
    checkRuns.push(...result.check_runs);
    if (result.check_runs.length < 100) break;
  }
  const candidates = checkRuns.filter((run) =>
    run.status === 'completed' && run.conclusion === 'success' &&
    run.name === EVIDENCE_CHECK_NAME &&
    run.app?.slug === 'github-actions');
  const trusted = new Set(trustedPolicyShas());
  for (const candidate of candidates) {
    const detailsUrl = candidate.details_url;
    if (typeof detailsUrl !== 'string') continue;
    const runId = /\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:\?|$)/.exec(detailsUrl)?.[1];
    if (!runId) continue;
    const run = await githubApi<{
      id?: number;
      run_attempt?: number;
      event?: string;
      path?: string;
      display_title?: string;
      referenced_workflows?: Array<{ path?: string; sha?: string }>;
    }>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    const sourceIdentity = /^Dependabot auto-merge source=(\d+) attempt=(\d+)$/.exec(run.display_title ?? '');
    if (!sourceIdentity) continue;
    const sourceRunId = Number(sourceIdentity[1]);
    const sourceRunAttempt = Number(sourceIdentity[2]);
    const runAttempt = run.run_attempt ?? -1;
    const sourceRun = await githubApi<{
      id?: number;
      run_attempt?: number;
      event?: string;
      path?: string;
      conclusion?: string | null;
      actor?: { login?: string };
      pull_requests?: Array<{ number?: number; head?: { sha?: string } }>;
    }>(`/repos/${owner}/${repo}/actions/runs/${sourceRunId}`);
    const trustedReference = run.referenced_workflows?.find((workflow) =>
      workflow.path?.startsWith(`${owner}/${repo}/.github/workflows/dependabot-auto-merge-policy.yml@`) &&
      typeof workflow.sha === 'string');
    const expectedCaller = '.github/workflows/dependabot-auto-merge.yml';
    const callerWorkflowPath = run.path?.split('@')[0] ?? '';
    const reusablePolicyPath = trustedReference?.path?.split('@')[0]
      .replace(`${owner}/${repo}/`, '') ?? '';
    const externalId = [
      'provenance', sha, trustedReference?.sha ?? '', sourceRunId, sourceRunAttempt,
      runId, runAttempt,
    ].join(':');
    const jobs: Array<{
      name?: string;
      conclusion?: 'success' | 'failure' | 'cancelled' | null;
    }> = [];
    for (let page = 1; ; page += 1) {
      const jobsResult = await githubApi<{ jobs?: typeof jobs }>(
        `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(jobsResult.jobs)) {
        throw new Error('authoritative workflow jobs response is malformed');
      }
      jobs.push(...jobsResult.jobs);
      if (jobsResult.jobs.length < 100) break;
    }
    if (!Array.isArray(sourceRun.pull_requests)) {
      throw new Error('authoritative source workflow run response is malformed');
    }
    const authoritative = isAuthoritativeEvidenceRun({
      targetPullRequestNumber: pullRequestNumber,
      targetHeadSha: sha,
      provenanceJobName: 'Policy / Provenance evidence',
      expectedDispatcherWorkflowPath: '.github/workflows/dependabot-auto-merge.yml',
      expectedSignalWorkflowPath: '.github/workflows/dependabot-auto-merge-signal.yml',
      expectedSignalActor: 'dependabot[bot]',
      dispatcherRun: {
        id: Number(runId),
        runAttempt,
        event: run.event ?? '',
        path: callerWorkflowPath,
        sourceRunId,
        sourceRunAttempt,
      },
      sourceRun: {
        id: sourceRun.id ?? -1,
        runAttempt: sourceRun.run_attempt ?? -1,
        event: sourceRun.event ?? '',
        path: sourceRun.path?.split('@')[0] ?? '',
        conclusion: sourceRun.conclusion ?? null,
        actorLogin: sourceRun.actor?.login ?? '',
        headSha: sourceRun.pull_requests.find(({ number }) => number === pullRequestNumber)?.head?.sha ?? '',
        pullRequests: sourceRun.pull_requests.map((pullRequest) => ({
          number: pullRequest.number ?? -1,
          headSha: pullRequest.head?.sha ?? '',
        })),
      },
      jobsRunId: Number(runId),
      jobsRunAttempt: runAttempt,
      jobs: jobs.map((job) => ({
        name: job.name ?? '',
        conclusion: job.conclusion ?? null,
      })),
    });
    if (run.event === 'workflow_run' && trustedReference?.sha && authoritative &&
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
          eventName: 'workflow_run',
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

async function compareCommits(base: string, head: string): Promise<CompareResult> {
  const { owner, repo } = repository();
  return await githubApi<CompareResult>(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
}

function expectedMergeTree(firstParent: string, secondParent: string): string | null {
  const { owner, repo } = repository();
  const authorization = Buffer.from(`x-access-token:${requiredEnv('GITHUB_TOKEN')}`).toString('base64');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  };
  const remote = `https://github.com/${owner}/${repo}.git`;
  const repositoryDir = mkdtempSync(join(tmpdir(), 'dependabot-merge-tree-'));
  try {
    const run = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', env });
    if (run(['init', '--bare', repositoryDir]).status !== 0) return null;
    if (run(['-C', repositoryDir, 'remote', 'add', 'origin', remote]).status !== 0) return null;
    if (run(['-C', repositoryDir, 'config', 'remote.origin.promisor', 'true']).status !== 0) return null;
    if (run(['-C', repositoryDir, 'config', 'remote.origin.partialclonefilter', 'blob:none']).status !== 0) {
      return null;
    }
    const fetched = run([
      '-C', repositoryDir, 'fetch', '--filter=blob:none', '--no-tags', '--no-recurse-submodules',
      'origin', firstParent, secondParent,
    ]);
    if (fetched.status !== 0) return null;
    const merged = run(['-C', repositoryDir, 'merge-tree', '--write-tree', firstParent, secondParent]);
    if (merged.status !== 0) return null;
    const tree = merged.stdout.trim().split(/\r?\n/, 1)[0];
    return /^[0-9a-f]{40}$/i.test(tree) ? tree : null;
  } finally {
    rmSync(repositoryDir, { recursive: true, force: true });
  }
}

async function updateMechanismTopology(
  headSha: string,
  baseSha: string,
  pullRequestNumber: number,
): Promise<{
  topology: { parentShas: string[]; secondParentInBase: boolean; introducesOnlyBaseChanges: boolean };
  parentEvidence: StoredResult[];
  reason: string;
}> {
  const { owner, repo } = repository();
  const commit = await githubApi<{ parents?: Array<{ sha?: string }>; tree?: { sha?: string } }>(
    `/repos/${owner}/${repo}/git/commits/${encodeURIComponent(headSha)}`,
  );
  const parentShas = Array.isArray(commit.parents)
    ? commit.parents.map(({ sha }) => sha ?? '')
    : [];
  const topology = { parentShas, secondParentInBase: false, introducesOnlyBaseChanges: false };
  if (parentShas.length !== 2 || parentShas.some((sha) => !sha)) {
    return { topology, parentEvidence: [], reason: 'update topology requires exactly two parents' };
  }

  const [firstParent, secondParent] = parentShas;
  if (!await hasPositiveEvidence(firstParent, pullRequestNumber)) {
    return { topology, parentEvidence: [], reason: 'first parent has no trusted positive provenance evidence' };
  }
  const parentEvidence: StoredResult[] = [{
    sha: firstParent,
    kind: 'provenance',
    producer: EVIDENCE_PRODUCER,
    conclusion: 'positive',
  }];

  const ancestry = await compareCommits(secondParent, baseSha);
  topology.secondParentInBase = ancestry.merge_base_commit?.sha === secondParent &&
    (ancestry.status === 'ahead' || ancestry.status === 'identical');
  if (!topology.secondParentInBase) {
    return { topology, parentEvidence, reason: 'second parent is outside current base ancestry' };
  }

  const actualTree = commit.tree?.sha;
  const mergedTree = expectedMergeTree(firstParent, secondParent);
  topology.introducesOnlyBaseChanges = typeof actualTree === 'string' && mergedTree === actualTree;
  return {
    topology,
    parentEvidence,
    reason: topology.introducesOnlyBaseChanges
      ? 'trusted update topology contains only base changes'
      : 'update topology diff contains changes outside the base branch',
  };
}

function output(name: string, value: string | boolean): void {
  const target = requiredEnv('GITHUB_OUTPUT');
  appendFileSync(target, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
}

function publishAssessment(
  current: ApiPullRequest,
  event: PolicyEvent,
  classification: { eligible: boolean; reason: string; status: string },
  evaluation: HeadEvaluation,
  topologyReason = '',
): void {
  const originPositive = evaluation.evidence.conclusion === 'positive';
  const provenanceConclusion = originPositive ? 'success'
    : evaluation.evidence.conclusion === 'skipped' ? 'skipped' : 'failure';
  output('assessment-status', classification.status);
  output('eligible', classification.eligible);
  output('origin-positive', originPositive);
  // gate-ok remains an authorization bit, independent of job completion success.
  output('gate-ok', evaluation.gate.conclusion === 'success');
  output('eligibility-conclusion', evaluation.gate.conclusion ?? 'failure');
  output('provenance-conclusion', provenanceConclusion);
  output('record-evidence', evaluation.recordEvidence);
  output('enable-auto-merge', evaluation.enableAutoMerge);
  output('disable-auto-merge', evaluation.disableAutoMerge);
  output('auto-merge-enabled', current.auto_merge !== null);
  output('pr-number', current.number.toString());
  output('head-sha', current.head.sha);
  output('reason', [classification.reason, topologyReason, evaluation.gate.reason].filter(Boolean).join('; '));
  console.log(JSON.stringify({
    pullRequest: current.number, head: current.head.sha, action: event.action,
    classification, originPositive, gate: evaluation.gate,
    enable: evaluation.enableAutoMerge, disable: evaluation.disableAutoMerge,
  }, null, 2));
}

async function main(): Promise<void> {
  const event = policyEvent();
  const { owner, repo } = repository();
  const current = await githubApi<ApiPullRequest>(`/repos/${owner}/${repo}/pulls/${event.pullRequestNumber}`);
  if (!current || current.number !== event.pullRequestNumber ||
      typeof current.head?.sha !== 'string' || !current.head.sha ||
      typeof current.user?.login !== 'string' || !current.user.login.trim() ||
      !Object.hasOwn(current, 'auto_merge') ||
      (current.auto_merge !== null && (typeof current.auto_merge !== 'object' || Array.isArray(current.auto_merge)))) {
    throw new Error('fresh pull-request snapshot is malformed');
  }
  if (current.head.sha !== event.headSha) {
    throw new Error(`event head ${event.headSha} is stale; current head is ${current.head.sha}`);
  }

  if (current.user.login !== 'dependabot[bot]') {
    const evaluation = evaluateHead({
      sha: current.head.sha, autoMergeEnabled: current.auto_merge !== null,
      classificationEligible: false, classificationStatus: 'not-applicable',
      action: event.action as HeadEvaluationInput['action'],
      prAuthor: current.user.login, actor: null,
      signature: { valid: false, wasSignedByGitHub: false, signerLogin: null },
      expectedEvidenceProducer: EVIDENCE_PRODUCER,
    });
    publishAssessment(current, event, { eligible: false, status: 'not-applicable', reason: '' }, evaluation);
    return;
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

  const action = event.action;
  const introducesHead = action === 'opened' || action === 'synchronize';
  const signature = await signatureFor(current.head.sha);
  const priorEvidence = introducesHead ? false : await hasPositiveEvidence(current.head.sha, current.number);
  const actorLogin = event.actor;
  let storedResults: StoredResult[] = priorEvidence ? [{
    sha: current.head.sha,
    kind: 'provenance',
    producer: EVIDENCE_PRODUCER,
    conclusion: 'positive',
  }] : [];
  const updateMechanismLogin = process.env.UPDATE_MECHANISM_LOGIN ?? '';
  const directDependabot = introducesHead && actorLogin === 'dependabot[bot]';
  const trustedUpdater = introducesHead && updateMechanismLogin.length > 0 && actorLogin === updateMechanismLogin;
  let topology: {
    parentShas: string[];
    secondParentInBase: boolean;
    introducesOnlyBaseChanges: boolean;
  } | undefined;
  let topologyReason = '';
  if (trustedUpdater) {
    const result = await updateMechanismTopology(current.head.sha, current.base.sha, current.number);
    topology = result.topology;
    storedResults = result.parentEvidence;
    topologyReason = result.reason;
  }
  const evaluation = evaluateHead({
    sha: current.head.sha,
    autoMergeEnabled: current.auto_merge !== null,
    classificationEligible: classification.eligible,
    classificationStatus: classification.status,
    action: event.action as HeadEvaluationInput['action'],
    prAuthor: current.user.login,
    signature,
    actor: directDependabot
      ? { login: actorLogin, kind: 'dependabot' }
      : trustedUpdater
        ? { login: actorLogin, kind: 'update-mechanism' }
        : priorEvidence
          ? { login: 'dependabot[bot]', kind: 'dependabot' }
          : { login: actorLogin, kind: 'human' },
    topology,
    storedResults,
    expectedEvidenceProducer: EVIDENCE_PRODUCER,
  });
  publishAssessment(current, event, classification, evaluation, topologyReason);
}

await main();
