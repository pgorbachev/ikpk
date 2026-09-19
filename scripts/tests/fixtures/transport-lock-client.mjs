import { createSshTransport } from '../../publication-transport.mjs';

const config = JSON.parse(process.argv[2]);
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
