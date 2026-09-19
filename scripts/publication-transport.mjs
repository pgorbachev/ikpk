// RED scaffold only. The approved publication transport has not been implemented.
export function createSshTransport() {
  const session = {
    async stage() {},
    async activate() {},
    async rollback() {},
  };
  return {
    async withLock(callback) { return callback(session); },
    async recover() { return { recovered: false }; },
  };
}
