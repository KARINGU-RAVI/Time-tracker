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
| Leaderboard (opted-in + not-opted-in states) | 504c15bc88dc4f92b66fd443b87c8e4d | 0fd969f0f03440f3b88d1afea9c816a0 |
| Leaderboard, opted-out state (desktop only; mobile has it as a second frame on the same screen) | — | c0cc7e79747d4d4cb5ab443902d76198 |

## Known issues
- Stitch previews do not refresh after in-place edits (desktop Today, desktop Summary): verify visually in the Stitch UI.
- Desktop design system keeps re-deriving `colorVariant: FIDELITY` and primary `#1E30B2` (mobile is `#3F50CE`). Cosmetic mismatch.
- Do NOT use `apply_design_system` again: it rewrote the desktop status colors and duplicated screens.
- Generation timeouts usually finish late and create the screen anyway. List screens before retrying.
- The Stitch API key was pasted in chat. Regenerate it.

## Still to design
- Month view of Summary, unpaid-leave (LOP) warning state on Leave, loading / empty / error / offline states, dark theme, "Add session" mobile bottom sheet (if missing).

## Multi-user auth screens (mobile project 2797482494668543841, added 19 Sep 2026)
| Screen | Screen id | Notes |
|---|---|---|
| Sign in (+ 2 error states) | eeef5bc139a847ea89190c0bd974f3d2 | Error preview uses an invented address (alden.walker@domain.io): replace with you@example.com |
| Create account (+ 3 error states, Turnstile placeholder, password checklist) | a0c4b73e55a34f0abb5690a13ff8b240 | |
| Email flow canvas: check your email, verified, forgot password, new password (+ expired link) | 11f19f8ae79e4b069c0a84ae461ad5d5 | Generated as a wide desktop-size canvas (2560 px) with four phone frames |
| Setup wizard (5 frames: profile, work hours, leave, holidays, review) | NOT GENERATED: timed out on first try, list before retrying | Split into two prompts if it times out again |
Desktop versions of the auth screens are not designed: the layout is a centered card, same as mobile.
