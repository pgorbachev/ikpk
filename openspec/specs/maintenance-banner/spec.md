# maintenance-banner Specification

## Purpose
Allow the site administrator to include a maintenance notice in a static build without editing source code.
## Requirements
### Requirement: Build-time maintenance switch
The site SHALL accept `MAINTENANCE_BANNER=on|off` at build time. An unset, empty, or whitespace-only value SHALL mean off. Surrounding whitespace SHALL be ignored. Other values SHALL fail the build with an error identifying the parameter. Changing the notice on a published static site SHALL require rebuilding and publishing the result.

#### Scenario: Default and explicit off
- **WHEN** the parameter is unset, empty, whitespace-only, or `off`
- **THEN** neither shared layout outputs a maintenance notice

#### Scenario: Explicit on
- **WHEN** a non-demo build uses `on`
- **THEN** both shared layouts output exactly one existing maintenance notice before navigation, outside the indexed main content, including noindex pages
- **AND** canonical URLs, robots directives, forms, analytics, and page content retain their existing behavior

#### Scenario: Invalid configuration
- **WHEN** a build uses any other non-empty value
- **THEN** the build fails with an error naming `MAINTENANCE_BANNER`

### Requirement: Demo notice takes precedence
Demo output and demo-form builds SHALL retain their existing demo notice behavior and SHALL NOT output a maintenance notice even with the switch on.

#### Scenario: Demo with maintenance enabled
- **WHEN** demo output or demo forms are enabled and maintenance is on
- **THEN** both shared layouts omit the maintenance notice and retain the existing demo notice behavior

### Requirement: Publication build configuration
The existing host publication configuration SHALL accept an optional `maintenanceBanner` value of `on` or `off`, defaulting to `off`, and pass it as `MAINTENANCE_BANNER` to the static build. Invalid values SHALL be rejected before starting child commands. The selected configuration SHALL remain bound by the existing publication provenance checks.

#### Scenario: Server-side build receives explicit configuration
- **WHEN** an operator prepares a normal publication with `maintenanceBanner` set to `on` or `off`
- **THEN** the static build receives the corresponding environment variable without depending on the operator shell environment

#### Scenario: Missing or invalid host setting
- **WHEN** the host setting is absent
- **THEN** the static build receives `off`
- **WHEN** the host setting is not `on` or `off`
- **THEN** the operation fails before launching child commands

