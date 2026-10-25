export function usesPublicationCandidateCapture(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUBLICATION_STAGING_CAPTURE === '1' ||
    env.PUBLICATION_INITIAL_PRODUCTION_CAPTURE === '1' ||
    env.PUBLICATION_PRODUCTION_STATIC_CAPTURE === '1';
}
