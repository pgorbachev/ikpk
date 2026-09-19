// Trusted test-only policy. Never imported by the production worker or accepted from JSON.
export function createTestAuthorizer(identity) {
  return async ({ operation, expectedDigest }) => ({
    destinationId: identity.destinationId,
    commit: operation?.commit ?? identity.commit,
    snapshotId: operation?.snapshotId ?? identity.snapshotId,
    treeDigest: operation?.treeDigest ?? expectedDigest ?? identity.treeDigest,
  });
}
