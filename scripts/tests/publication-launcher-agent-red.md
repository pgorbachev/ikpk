# Independent launcher to transport agent handoff — RED

Production code under review: `feat/manual-publication-transport@f5d0d434d6d651cdbee3e1dcc2c0fd79153924c4`. Test delivery follows the operation-binding RED commit `0601563e20691178e8e582619d7ac885c4c3c689` without production edits.

```sh
node --test --test-reporter=tap scripts/tests/publication-launcher-agent.test.mjs
```

Result: **1 failed, 0 skipped**, exit 1 (`credential-broker-failed`). Both new test files pass `node --check`.

## Confirmed P2: credential broker cannot deliver the transport's agent socket

The allowlist in `scripts/publication-launcher.mjs:102` accepts `SSH_KEY` but rejects `SSH_AUTH_SOCK`. Its sanitized environment omits the ambient socket. `scripts/publication-transport.mjs:59` uses `SSH_AUTH_SOCK` and does not consume `SSH_KEY`. Consequently, an operator whose authorized broker supplies an SSH agent socket cannot reach transport through the launcher; the failure occurs after the broker actually supplies it.

The independent fixture starts a real local Unix socket, whose payload is a test canary. Its positive control runs the same checked-in fixture worker and actual transport directly: the SSH adapter opens the socket, verifies the canary, runs the real remote Python protocol locally and uploads checked bytes. The adapter records arguments and a boolean, not the canary. The launcher then freshly clones that canonical repository and invokes its configured broker, but rejects the socket before executing the worker. This is an integration failure, not a nonfunctional fake channel.

The fixture does not implement a real SSH authentication protocol and contacts no server. A GREEN test will establish capability handoff and absence of the canary in arguments/output/artifacts; it will not establish real host authentication, production key restrictions, protected ownership or hardening acceptance. Ambient socket delivery before source verification is not requested: credentials must still be released only by the broker after source authorization.

`recordIndex` receives a structured clone, so mutation of its argument cannot alter the transport's original in-memory operation. That protection does not cover durable pending replacement during the callback; the earlier operation-binding RED explicitly demonstrates that separate failure.
