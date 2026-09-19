import type { CiEvidence } from './publish-gate.ts';

export interface CiArtifact {
  id: number; name: string; archive_download_url: string; expired?: boolean;
  workflow_run?: { id: number; head_sha?: string };
}
export interface ReadCiEvidenceOptions {
  commit: string; token?: string; fetch?: typeof globalThis.fetch;
  readReports?: (artifact: CiArtifact, context: { fetch: typeof globalThis.fetch; token?: string }) => Promise<Record<string, unknown>>;
}

/** RED scaffold. Production defaults and fixed policy still need implementation. */
export async function readCiEvidence(options: ReadCiEvidenceOptions): Promise<CiEvidence> {
  void options;
  return undefined as unknown as CiEvidence;
}
