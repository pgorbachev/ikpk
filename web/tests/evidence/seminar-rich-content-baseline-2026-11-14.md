# Seminar rich-content inventory repair

Source revision: `30415627a7f23b049991beea9d8af1dc2d4b946d`.

The baseline red run had two failures: unlisted CMS richtext `seminar.audience`, and five relocated executable slots in four Astro files. All 149 live source slots retain their original semantic identity. The five changed locators have unique same-file, same-node-kind, same-identity matches; their location-dependent fingerprints were refreshed. Exactly 26 of 11,237 occurrence rows were remapped; no occurrence identity, route, placement or count was admitted or removed. The occurrence registry retains its original dist-generation revision because this is a source-locator repair, not a regenerated build allowlist.

The new `audience` selector is CMS-only in the pinned content fixture, like `learning_plan`. The real seminar page sanitizes it through `cleanBodyHtml` and the terminal `RichContent` component; a render test preserves prose and HTTPS links while rejecting script, event attributes, javascript URLs and forged rich-content markers.

A separate regression exposed the structured-page marker mismatch: the snapshot projection expected one `seminar-body`, while structured rendering emits individual description/audience/learning_plan/learning_mode/recommendations markers. The projection now derives the exact route/count for each marker from source fields and content_format. Description follows the template's truthiness test; other sections require nonblank text. Five explicit zero-count fixture sinks keep unknown/extra marker rejection intact. Negative tests reject missing, duplicate, legacy-body and wrong-route markers.

Validation: baseline red 28 passed / 2 failed; structured projection regression red; baseline/contract/hazard/publication occurrence suites green (226 tests); terminal render suite green (10 tests), including exact marker projection versus actual structured and legacy Astro output. Full production/demo dist validation remains a separate check, not claimed by these unit and container results.
