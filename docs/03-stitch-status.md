# Stitch design status (19 Sep 2026)

Stitch projects (private, in the user's Google account):
- Mobile: `projects/2797482494668543841` (design system `assets/10808536589267917058`)
- Desktop: `projects/13148178270151600541` (design system `assets/12449616052641688442`)

## Screens: latest copy to use (older duplicates exist; delete in the Stitch UI, the API has no delete)

| Screen | Mobile (screen id) | Desktop (screen id) |
|---|---|---|
| Today | 080fdda7453f44f9a576c2a3ab9932c4 | 24fa734ea5544c95a225f0d8c74c3098 (older: a863f24e...) |
| Day Detail (missing OUT) | 24cce7cf2597435d943fda6e6d677f7d | 907e814680cf40cc94a148c0aac5b1bf (older: 5404980240...) |
| Leave | 52cf7c730e804b92ba0866905f39308f | e7dd42460ed74fb4ba4bc4b5b4c02846 |
| Calendar | 592f8c776d1f4023be92fe8c43850beb | b3163eb0dd004c8092cfa9df5268d474 |
| Summary (week) | a709fdcf90434c4281d345dcac303ad9 | 8e06fa9ad4634bcfa4e79a45bfdc5fc9 |
| Add session | NOT CONFIRMED (timed out; may have completed late) | 0a313bb9b37749e08915cc804c22ab3f |
| Holidays + import preview | d043c4186f8b4c69989e2c6d1e00812d, 10f41f3a973b4f36842cc925837bb5dd | 60e225be5ca340879162dbb1e3ab184c |
| Settings | d7ea0eb755544268ba497ddf0345a99c | 976769c3d482485f9a998ea85ca770ae |
| Login (+ error state) | ae8d5d05f1c94b86818dd546da6b8179 | 9b01a4ad822c4564b474a9f03bbacc63 |

## Known issues
- Stitch previews do not refresh after in-place edits (desktop Today, desktop Summary): verify visually in the Stitch UI.
- Desktop design system keeps re-deriving `colorVariant: FIDELITY` and primary `#1E30B2` (mobile is `#3F50CE`). Cosmetic mismatch.
- Do NOT use `apply_design_system` again: it rewrote the desktop status colors and duplicated screens.
- Generation timeouts usually finish late and create the screen anyway. List screens before retrying.
- The Stitch API key was pasted in chat. Regenerate it.

## Still to design
- Month view of Summary, unpaid-leave (LOP) warning state on Leave, loading / empty / error / offline states, dark theme, "Add session" mobile bottom sheet (if missing).
