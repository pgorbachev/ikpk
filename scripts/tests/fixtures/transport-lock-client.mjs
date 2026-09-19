import { createSshTransport } from '../../publication-transport.mjs';
import { createTestAuthorizer } from './transport-authorization.mjs';

const config = JSON.parse(process.argv[2]);
// Functions cannot cross the JSON boundary: install this trusted fixture policy here.
config.authorize = createTestAuthorizer({
  destinationId: config.destinationId, commit: 'a'.repeat(40),
  snapshotId: 'snapshot-new', treeDigest: 'a'.repeat(64),
});
try {
  process.send({ state: 'requesting' });
  await createSshTransport(config).withLock(async () => {
    process.send({ state: 'entered' });
    await new Promise((resolve) => process.once('message', resolve));
  });
  process.send({ state: 'released' });
  process.disconnect();
} catch (error) {
  process.send({ state: 'error', message: error.message });
  process.disconnect();
  process.exitCode = 1;
}
