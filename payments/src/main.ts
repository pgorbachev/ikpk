import { createPaymentService } from './app.js';

const app = createPaymentService({ env: process.env });

try {
  const started = await app.start();
  const port = started.port;
  process.stderr.write(`listening on ${port}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
