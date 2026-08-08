## Context

See proposal.md — Why. Visual redesign needs owner choice among three frames from
`docs/design/studio-references.md` §7 before appearance work. Preview already
ships only under `DEMO_FORMS` (same isolation pattern as `/demo-zayavka`).

## Goals / Non-Goals

**Goals:**
- Comparable live surfaces per frame on real discovery data.
- Factual attribution (teachers, dates, counts) so demos do not lie.
- Spec that legalizes deferred §7.6/§7.7 depth for this demo change.

**Non-Goals:**
- Shipping chosen frame to production appearance.
- Full schedule UX parity with `/raspisanie-i-tseny`.
- CI `build:demo` job in this change (tracked as TD-14).

## Decisions

1. **Demo-only static paths** over feature flags in production HTML — avoids
   accidental public drafts; mirrors existing demo-zayavka catch-all hub.
2. **Separate undated URL** instead of forcing an undated state on the dated
   page — dated page always picks a future schedule row; undated picks a seminar
   without future rows.
3. **Teacher resolution via `seminar.teachers` / schedule leads only** — institute
   “first photo” fallback rejected after it mis-attributed leads on undated demos.
4. **Short schedule sample (6)** for prototype comparison — full 63-row stress
   and filters deferred; called out in proposal/spec as non-requirement.
5. **`instituteShortBySlug` map** only when no schedule shortname is available —
   returns raw slug for unknown institutes rather than inventing a label.

## Risks / Trade-offs

- [CI skips prototype gates] → TD-14; demos verified locally with `build:demo`.
- [Reduced schedule depth under-tests dense layouts] → accepted for owner choice
  demo; follow-up change if owner picks a frame that needs stress proof.
- [Retroactive OpenSpec after code] → change must be approved before merge; fixes
  for attribution/date land with the change, not as silent scope creep.

## Migration Plan

- No production migration: previews absent without `DEMO_FORMS`.
- After owner picks a frame, a separate change implements production appearance.
