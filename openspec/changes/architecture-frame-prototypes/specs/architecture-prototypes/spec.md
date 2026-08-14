## Purpose

Demo-only preview of three site architecture frames so the owner can choose a
delivery style on real catalog data before a visual redesign is implemented.

## ADDED Requirements

### Requirement: Preview routes exist only in demo builds
The system SHALL emit architecture preview routes under `/preview/` only when
demo forms mode (`DEMO_FORMS` / demo build) is enabled. A production build SHALL
NOT contain those routes as reachable pages.

#### Scenario: Production build has no architecture previews
- **WHEN** the site is built without demo forms mode
- **THEN** `/preview/editorial`, `/preview/faculty`, `/preview/modular` and their
  seminar/schedule children are absent from the build output

#### Scenario: Demo build exposes the hub and three frames
- **WHEN** the site is built with demo forms mode
- **THEN** `/preview/hub` and `/preview/{editorial,faculty,modular}` plus
  `/seminar`, `/seminar-undated`, and `/schedule` for each frame are present

### Requirement: Each frame has home, dated seminar, undated seminar, and schedule
For each architecture id `editorial`, `faculty`, and `modular`, the demo build
SHALL provide four comparable surfaces: home, seminar with a date, seminar
without dates, and schedule.

#### Scenario: Undated seminar is reachable and marked
- **WHEN** a visitor opens `/preview/{id}/seminar-undated` in a demo build
- **THEN** the page is served and includes an undated-state marker in the seminar
  header region

#### Scenario: Dated and undated are separate URLs
- **WHEN** a visitor compares dated and undated seminar prototypes for one frame
- **THEN** they use distinct paths (`/seminar` vs `/seminar-undated`) rather than
  a single page that always has a date

### Requirement: Frames differ by delivery architecture
The three frames SHALL differ in how the first screen and key blocks are
presented (hero, upcoming event, seminar header, schedule layout), not only by
reordering identical sections.

#### Scenario: Editorial upcoming event is a line, not a teacher card
- **WHEN** `/preview/editorial` is rendered
- **THEN** the upcoming event is presented as an announcement line and MUST NOT
  use the faculty teacher-event card markup

#### Scenario: Faculty upcoming event includes the teacher
- **WHEN** `/preview/faculty` is rendered
- **THEN** the upcoming event presentation includes teacher attribution distinct
  from the editorial line

#### Scenario: Modular home includes picker and date grid
- **WHEN** `/preview/modular` is rendered
- **THEN** the page includes a modular picker region and a modular upcoming-dates
  region

### Requirement: Seminar teacher attribution must be factual
A seminar prototype SHALL attribute a teacher only from that seminar’s catalog
teachers or from the schedule entry’s teachers. The system MUST NOT invent a
teacher by picking an unrelated institute portrait.

#### Scenario: Undated seminar uses seminar.teachers
- **WHEN** an undated seminar prototype shows a teacher name or portrait
- **THEN** that teacher belongs to `seminar.teachers` for the displayed seminar

#### Scenario: No seminar teachers means no invented lead
- **WHEN** the displayed seminar has an empty teachers list
- **THEN** the prototype does not claim a specific named instructor as the lead

### Requirement: Dated seminar header shows the date in every frame
When a seminar prototype is the dated variant, each frame’s header SHALL include
the date label of the nearest schedule entry.

#### Scenario: Faculty dated header includes the date
- **WHEN** `/preview/faculty/seminar` is rendered with a schedule entry
- **THEN** the faculty header facts include the date label (not only city,
  duration, and price)

### Requirement: Preview pages are noindex and honest about stubs
Architecture preview pages SHALL be `noindex`. Interactive controls that do not
yet filter or submit real results SHALL be labeled as stubs rather than presented
as working product behavior.

#### Scenario: Preview is excluded from indexing signals
- **WHEN** a preview page is built
- **THEN** it carries a noindex robots directive and is excluded from the sitemap

#### Scenario: Non-functional picker is labeled
- **WHEN** the modular home picker does not drive schedule filtering
- **THEN** the UI states that filters are not connected yet (or equivalent honest
  wording)

### Requirement: Deferred depth is out of this capability’s MUST set
This capability does NOT require: modular curriculum accordion by day/topic;
schedule prototypes over the full active event list with filters; faculty
grouping by month; cycle-collection badges; or a CI job that builds demo mode.
Those MAY be added by a later change; their absence MUST NOT be treated as an
unspecified defect of this capability once this change is approved.

#### Scenario: Approval covers reduced schedule depth
- **WHEN** this change is approved with schedule prototypes limited to a small
  upcoming subset for comparison
- **THEN** that limitation is an accepted scope boundary, not an open requirement
  of this capability

### Requirement: Preview seminar HTML uses the central rich-content sink
Dated and undated seminar prototypes SHALL render seminar body HTML through
`RichContent` with the registered sink IDs `preview-seminar-body` and
`preview-seminar-undated-body`. They SHALL NOT add production `set:html`, `is:raw`,
or `srcdoc`.

#### Scenario: Preview seminar bodies stay on registered sinks
- **WHEN** a demo build emits `/preview/{id}/seminar` and `/preview/{id}/seminar-undated`
- **THEN** each seminar body is wrapped by `RichContent` with the matching registered
  sink ID, and the preview templates do not introduce another `set:html`
