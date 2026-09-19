# Retained checks review fixes

Independent RED: `b42a9ad1ce68c7d0898924cbbe79edccb152bc0b` (integrated `f1ea0229cd273f474f223cf5bee2f4065b3bed42`).

The schedule smoke now requires a positive card count and a visible card and registration link. The previous hidden-card experiment falsely passed all 13 assertions. With the fix, the same CSS mutation produces 6 passing / 2 failing browser tests, specifically the schedule smoke on desktop and mobile; acceptance refuses. Visible cards fall from 25 to 0 on both widths. The pristine retained artifact passes all 13 assertions and its digest is unchanged. The mutation copy is restored to the same digest.

Rollback check audit now includes the actual count carried by a typed local report error, including zero, just as fresh publication checks do. The two independent tests switch from RED to GREEN. Combined rollback checks, adapter and count suites: 20/20. Focused lint passes.

The saved historical RED evidence remains unchanged; separate GREEN JSON records accompany this fix. No CMS, SSH or production host was accessed.
