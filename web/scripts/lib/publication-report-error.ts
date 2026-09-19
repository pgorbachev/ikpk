/** Counts established by a fixed report reader, without retaining report contents. */
export class PublicationReportError extends Error {
  constructor(message: string, readonly source: 'ci' | 'local', readonly executedTests: number) {
    super(message);
    if (!Number.isSafeInteger(executedTests) || executedTests < 0) throw new Error('invalid publication report count');
  }
}
