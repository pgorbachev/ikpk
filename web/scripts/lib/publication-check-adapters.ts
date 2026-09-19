// RED contract only. Production effect adapters and fixed suites are not implemented.
import type { PublicationCheckPorts } from './publication-checks.ts';

export interface PublicationCommand {
  file: string; args: string[]; cwd: string; env: Record<string, string | undefined>;
}
export interface PublicationProcessResult { exitCode: number | null; signal?: string | null }
export interface PublicationPreview {
  baseUrl: string;
  close(): Promise<void>;
}
export interface PublicationAdapterRuntime {
  run(command: PublicationCommand): Promise<PublicationProcessResult>;
  startPreview(input: { treeDir: string; env: Record<string, string | undefined> }): Promise<PublicationPreview>;
}
export interface PublicationAdapterOptions {
  webRoot: string; snapshotDir: string; reportsDir: string; ledgerDir: string;
  captureEnv: Record<string, string | undefined>;
  payment?: { endpoint: string; readinessUrl: string; mode: 'test' | 'prod'; shopId: string; siteOrigin: string };
}

/** Installed-worker library API; runtime injection is unavailable to operator JSON/CLI. */
export function createPublicationCheckPorts(
  options: PublicationAdapterOptions,
  runtime?: PublicationAdapterRuntime,
): PublicationCheckPorts {
  void options; void runtime;
  return {
    async capture() { return undefined as never; },
    async build() {},
    async checkSnapshot() { return undefined as never; },
    async checkBuild() { return undefined as never; },
    async checkDestination() { return undefined as never; },
    async checkBrowser() { return undefined as never; },
    async checkPaymentAbsent() { return undefined as never; },
    async checkPaymentReadiness() { return undefined as never; },
    async checkPaymentPreflight() { return undefined as never; },
    async digest() { return undefined as never; },
  };
}
