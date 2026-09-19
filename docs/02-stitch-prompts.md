# Stitch Prompts: Office Hours Tracker

How to use:
1. Create **two Stitch projects side by side**: "Office Hours: Mobile" (device = Mobile) and "Office Hours: Desktop" (device = Web/Desktop). Paste **Prompt 0** into both so the style is identical.
2. For each screen prompt, run it in **both projects back to back**, so the two layouts are designed together and stay consistent. Use the **Desktop notes** under each prompt (or the Prompt 9 layout rules) in the Desktop project.
3. Paste **one screen prompt at a time**. Do not combine screens.
4. For each screen, also generate the **state variants** listed under it (ask Stitch: "Show the same screen when ...").
5. Review against the **Checklist** at the end, then share screenshots or exports back for the next step.

Sample data below matches the spec (today = Sat 19 Sep 2026 in the doc; for the mockups use **Friday 18 Sep 2026** so it is a working day).

---

## Prompt 0: Design System (paste first)

```
Design a mobile-first web app called "Office Hours" for one person to track
their office attendance and working hours. It is used many times a day in
quick glances, often one-handed on a phone at the office gate. The design must
feel calm, trustworthy and precise, like a good watch or banking app, not
playful and not corporate-heavy.

STYLE
- Clean, minimal, generous whitespace, 8px grid, rounded corners 12px on cards,
  full pill shape on main buttons.
- Font: Inter. Use tabular (monospaced) numerals for ALL times and durations so
  digits do not jump when they change.
- Big numbers are the hero: worked time and remaining time are the largest
  elements on the dashboard.
- Support light and dark theme. Design light first, dark as a variant.
- Minimum touch target 48px. Body text 16px minimum. High contrast (WCAG AA).

COLOR (semantic, used consistently everywhere)
- Primary: deep indigo (#3B4CCA) for actions and the app accent.
- Target met / inside office / success: green (#1F9D55).
- Short hours / warning: amber (#D99A00).
- WFH: blue (#2F80ED).
- Leave (casual/sick/bereavement): orange (#E8762B).
- Holiday / optional holiday: teal (#1AA6A6).
- Weekly off: neutral gray (#9AA0A6).
- Incomplete / needs fix / error: red (#D64545).
- Never use color alone: always pair with an icon or text label.

NAVIGATION
- Mobile: bottom tab bar with 5 tabs: Today, Calendar, Leave, Summary, More.
  Active tab in indigo with label.
- Desktop: left sidebar with the same items, content max width 1100px.

COMPONENTS
- Status pill (rounded label with dot + text).
- Stat card (label small gray, value large).
- Progress ring/bar for worked vs required.
- Session row: "08:00 → 10:00   2h 00m".
- Bottom sheet for forms on mobile, centered modal on desktop.
- Toast for confirmations, inline banner for warnings.

EVERY SCREEN MUST ALSO DESIGN: loading skeleton, empty state, error state
("Can't reach server, retry"), offline banner.
```

---

## Prompt 1: Today (Dashboard) [most important]

```
Design the "Today" dashboard screen for Friday, 18 Sep 2026 (IST).

TOP: date "Fri, 18 Sep 2026" and a live clock "3:42 PM". Right side: avatar.

STATUS PILL: green "Inside office" with a pulsing dot.

HERO CARD (largest element):
- Circular progress ring showing worked vs required (6h 50m of 8h, ring ~85%).
- Center of ring: "6h 50m" huge, below it "worked today".
- Under the ring, three stat cells in a row:
  Required "8h 00m" | Remaining "1h 10m" | Expected OUT "4:52 PM".
- Under that, the message: "You need 1h 10m more." in a friendly line.

PRIMARY ACTION: one very large full-width pill button "Check Out" (red-toned
when inside, indigo "Check In" when outside). Thumb-reachable, above the
bottom tab bar. Small secondary text link below: "Add session manually".

TODAY'S SESSIONS card:
- 08:02 → 11:30    3h 28m
- 12:15 → 15:42    3h 22m   (with a small "now" chip and pulsing dot, ticking)
- Between them a light gray row: "Outside 45m".

THIS WEEK card (Mon-Fri):
- "Worked 30h 20m of 32h" (one leave day this week so required is 32h),
  a 5-segment mini bar for Mon-Fri with colors per day status,
  "Balance -1h 40m" in amber.
- Small note: "Thursday-Friday: 1h 40m to reach this week's target."

LEAVE CHIP row (tappable): "Annual leave 12.75 · Optional 1".

ALSO show a red inline banner at top on the variant screen (see states).

STATE VARIANTS to generate (same layout):
A. Not started yet (8:00 AM): status pill gray "Not checked in", big
   "Check In" button, worked 0h 00m, message "Start your day".
B. Outside office (lunch): status pill amber "Outside", button "Check In",
   note "If you return now, expected OUT is 5:37 PM".
C. Target completed: ring full green, message "Today's required hours
   are completed.", button "Check Out".
D. Overtime: "8h 45m completed, 45m overtime" with a subtle blue-green badge.
E. Incomplete previous day: red banner "Thu 17 Sep has no OUT. Fix it" with
   an action link, and the normal dashboard below.
F. Leave day (casual leave): no ring, big card "On casual leave", required 0,
   no missing-hours warning.
G. Holiday (Diwali): teal card "Company holiday: Diwali", "No work today".
H. Half-day leave: required shows "4h 00m".
I. Year-end banner (December): "18.00 leaves left. Only 3 carry forward,
   15.00 will lapse."
```

---

## Prompt 2: Calendar

```
Design the "Calendar" screen showing September 2026.

- Month header with left/right arrows and "September 2026". Week starts Monday.
- Monthly grid. Each date cell shows the day number and a small colored dot
  or fill, with tiny worked-time text under it on desktop (e.g. "8h 10m"):
  green = target met, amber = short, blue = WFH, orange = leave,
  teal = holiday (small star icon), gray = weekly off (Sat/Sun),
  red = incomplete (needs fix), dashed outline = unrecorded past working day.
  Today has an indigo ring.
- Sample data: 1-4 green, 7 amber, 8 blue WFH, 9 green, 10 green, 11 orange
  (leave), 14 green, 15 green, 16 amber, 17 red (incomplete), 18 today,
  weekends gray, 5 Sep marked holiday (teal).
- Legend row under the grid (scrollable on mobile).
- Month totals strip above the grid: Worked 121h 10m | Required 128h |
  Balance -6h 50m | Overtime 2h 30m | Leave 1 | WFH 1 | Unpaid (LOP) 0.
- Tapping a date opens Day Detail.

STATE VARIANTS: loading skeleton grid; empty month (no data yet); a month
containing a LOP day (show small "LOP" badge on that date).
```

---

## Prompt 3: Day Detail

```
Design the "Day Detail" screen for Thursday, 17 Sep 2026 with an INCOMPLETE
session (needs fix).

- Header: back arrow, "Thu, 17 Sep 2026", status pill red "Needs fix".
- Red inline banner: "The last session has no OUT time. Add it to include
  this time in your totals." with button "Add OUT time".
- Summary card: Required 8h 00m | Worked 4h 10m (counting closed sessions
  only) | Balance "-3h 50m" (amber) | Outside 45m.
- First IN 08:05 | Last OUT "missing".
- Sessions list (each row editable, swipe or overflow menu for edit/delete):
  08:05 → 12:15   4h 10m
  13:00 → (open)  "No OUT recorded" in red
- Notes field.
- Day status selector (segmented control or dropdown): Working, WFH,
  Casual leave, Sick leave, Bereavement, Optional holiday. Half-day toggle
  appears only for casual/sick leave.
- Checkbox "Manager informed" shown when the day is leave and will be LOP.
- Buttons: "Add session" (primary), "Delete day record" (destructive text).

STATE VARIANTS:
A. Healthy completed day (green, 8h 20m, +20m, three sessions 08:00 → 10:00,
   10:30 → 13:00, 13:45 → 17:35, outside 30m and 45m shown between them).
B. Holiday day (Diwali): read-only, "No work required", note "Worked on
   off-day" warning appears only if sessions exist and says those minutes
   are not counted.
C. WFH day with sessions 09:00 → 13:00 and 14:00 → 18:00 (8h).
D. Weekly off day.
E. Unrecorded past working day (dashed): "No record for this day.
   Add a session or set a status."
```

---

## Prompt 4: Add / Edit Session (bottom sheet)

```
Design an "Add session" bottom sheet over the Day Detail screen.

- Title "Add session", date "Thu, 17 Sep 2026".
- Two time pickers big and easy to tap: "IN" [08:05 AM] and "OUT" [ ]
  with a checkbox "Still inside (no OUT yet)".
- If OUT is on the next day (midnight crossing): a small toggle
  "OUT is on the next day".
- Live calculated line under the pickers: "Duration 4h 10m".
- Inline validation messages in red, clear and human:
  "OUT must be after IN."
  "This overlaps your 10:30-13:00 session."
  "You are already checked in since 08:00."
  "This session is longer than 16 hours. Check the date and time."
- Buttons: "Save" (primary), "Cancel", and "Delete" (destructive, only when
  editing).

VARIANTS: valid state, each error state above, saving spinner, network error.
```

---

## Prompt 5: Leave

```
Design the "Leave" screen.

TOP: two balance cards side by side (stacked on small phones):
1. "Annual leave (sick + casual)" 12.75 days available.
   Under it: "Carried from 2025: 2.00 · Accrued 2026: 15.75 · Used: 5.00".
   Small line "Next credit: +1.75 on 1 Oct".
2. "Optional leave" 1 of 2 remaining.

Below: a card "Bereavement leave (up to 5 days per event)", with list of
past events (empty state: "No events logged") and "Log an event" button.

Section "Apply leave": type selector (Casual / Sick / Bereavement /
Optional holiday), date range picker, "Half day" toggle, live summary
"2 working days (weekend skipped)".

WARNING VARIANT when balance is not enough: amber/red panel:
"Only 0.50 available. 1.50 day(s) will be unpaid (salary cut)."
Below it a "Message to manager" card with pre-filled text and buttons
"Copy" and "Email", and a checkbox "Manager informed".

Section "Ledger" (collapsible list): 01 Jan carry +2.00, monthly accruals
+1.75, 19 Sep adjustment -5.00, showing running balance.

Section "Unpaid (LOP) by month": chips like "Sep 2026: 0" "Nov 2026: 1.5".

Year-end banner variant (Nov/Dec): "Only 3 days carry forward. 15.00 will
lapse on 31 Dec."
```

---

## Prompt 6: Weekly / Monthly Summary

```
Design the "Summary" screen with a segmented control: Week | Month.

WEEK (week of 14-18 Sep 2026):
- Cards: Required 32h 00m | Worked 30h 20m | Balance -1h 40m (amber) |
  Weekly overtime 0m.
- Note "Required is 32h because of 1 leave day."
- Day rows Mon-Fri: date, status pill, worked, required, balance, and a
  thin bar. Example: Mon 14: 8h 10m, +10m; Tue 15: 8h 00m, 0;
  Wed 16: 7h 30m, -30m; Thu 17: Needs fix (red); Fri 18: 6h 50m today.
- Counts row: Working 4 · Leave 1 · WFH 0 · Holiday 0 · Weekly off 2.
- Prev / next week arrows.

MONTH (September 2026):
- Same cards plus Overtime and Leave taken.
- A simple bar chart of worked hours per day with a dashed line at 8h.
- Buttons: "Export CSV".

Empty state, loading skeleton, and a variant showing a LOP day counted.
```

---

## Prompt 7: Holidays and Import

```
Design the "Holidays" screen and a "Import holidays" bottom sheet.

Holidays screen:
- Year selector "2026". List grouped by month. Each row: date, name, type
  chip (Company teal / Optional light teal), description. Example:
  19 Oct Diwali, Company; 15 Aug Independence Day, Company;
  25 Dec Christmas, Optional.
- Top summary: "12 company holidays · 3 optional (quota 2, used 1)".
- Buttons: "Add holiday", "Import from file", and "Download template".
- Empty state for a new year: illustration + "Upload your company holiday
  calendar" with the two buttons.

Import sheet (3 steps):
1. Choose file (CSV or Excel), drag-and-drop area on desktop.
2. PREVIEW table with a status chip per row: New (green), Duplicate
   (amber), Error (red with message like "Invalid date"). Summary at top:
   "14 new · 2 duplicates · 1 error". A radio: "Duplicates: Skip existing /
   Overwrite existing".
3. Confirm button "Import 14 holidays", disabled if the file is unreadable.
   Success toast "14 holidays imported".
```

---

## Prompt 8: Login and Settings

```
Design two small screens.

LOGIN: centered card with app name "Office Hours", one line
"Your personal working-hours tracker", a "Sign in with Google" button.
Error variant: "This Google account is not allowed."

SETTINGS: sections
- Account (email, sign out)
- Work rule (read-only summary "8h/day, 40h/week, Mon-Fri, from 1 Sep 2026",
  link "Change rule" that explains a new version will be created)
- Tracking (start date, max session length 16h)
- Appearance (Light / Dark / System)
- Data (Export backup JSON, Import backup)
- Notifications (disabled toggles labelled "Coming soon")
```

---

## Prompt 9: Desktop layout rules (append to EVERY screen prompt in the Desktop project)

```
Design this screen for desktop (1280px), same content, colors and states as
the mobile version, so both are designed together. Left sidebar navigation. Today: two columns, left = hero ring and
Check In/Out; right = today's sessions and this week. Calendar: wide grid
with worked time shown in each cell. Day Detail: side panel that opens over
the calendar instead of a new page.
```

---

## Review checklist (I will check what you share against this)

- [ ] Worked time and remaining time are the largest items on Today
- [ ] Check In / Check Out is reachable with a thumb, one tap
- [ ] All times use tabular numerals
- [ ] Every status has icon/text plus color, not color alone
- [ ] Leave, holiday and weekly-off days never show a "missing hours" warning
- [ ] Incomplete day is clearly red, with a direct "fix" action
- [ ] LOP (unpaid) is visible before saving leave, and per month afterwards
- [ ] Every screen has loading, empty, error and offline states
- [ ] Dark theme is readable, status colors still distinct
- [ ] Nothing shows floating-point hours (always "Xh Ym")
