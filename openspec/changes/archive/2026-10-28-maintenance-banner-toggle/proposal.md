## Why
The administrator needs to enable the maintenance notice again without editing source code. PR #328 uses an obsolete base and defaults to showing a notice that has since been removed.

## What Changes
- Add a build-time `MAINTENANCE_BANNER=on|off` switch, defaulting to off.
- Reuse the previously accepted notice in both layouts; keep demo output free of duplicate notices.
- Pass the host configuration setting into the existing server build environment.
- Document rebuild/publication requirements. No deployment is included.

## Capabilities
### New Capabilities
- `maintenance-banner`: administrator-controlled maintenance notice in static output.
### Modified Capabilities
None.

## Impact
Both shared Astro layouts, render tests, host build environment and focused Python tests, and build documentation. No new dependency. Owner approved this behavior in the current conversation on 2026-10-28.
