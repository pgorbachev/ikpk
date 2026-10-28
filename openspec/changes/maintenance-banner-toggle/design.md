## Context
See proposal.md. Current main has no maintenance component; PR #328 contains the previously accepted markup and an obsolete default.

## Goals / Non-Goals
Use one shared component/configuration for both layouts. Preserve the existing notice appearance. Runtime toggling and deployment controls are outside this change.

## Decisions
Read the build environment with the same server-side import.meta.env/process.env fallback used by existing configuration. Validate before deciding whether a demo suppresses the notice. Keep the notice outside main and mark it ignored by Pagefind. Reuse #328 markup without adding a dependency or client script.

## Risks / Trade-offs
A mistyped value prevents a new build; the current published static output remains intact. Missing configuration defaults off. Operators must rebuild and follow normal publication checks; a process restart cannot change generated HTML. The host configuration accepts optional maintenanceBanner (strict on/off, default off) and explicitly passes it to the static build. Existing config hashing binds this setting to publication provenance; do not inherit the operator shell. Validate during config admission and before build child commands.
