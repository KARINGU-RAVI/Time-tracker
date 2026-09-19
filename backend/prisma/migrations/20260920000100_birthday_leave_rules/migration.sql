-- Birthday half-day leave: half a day, separate from annual leave.

-- A birthday record is always a half day; casual and sick leave may still be either.
ALTER TABLE "Attendance" DROP CONSTRAINT "attendance_half_day_only_casual_sick";
ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_half_day_only_casual_sick"
  CHECK ("dayFraction" = 1.0 OR "status" IN ('CASUAL_LEAVE', 'SICK_LEAVE', 'BIRTHDAY_LEAVE'));
ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_birthday_is_half_day"
  CHECK ("status" <> 'BIRTHDAY_LEAVE' OR "dayFraction" = 0.5);

-- No data is inserted here on purpose. Each account's yearly birthday allowance is created by the application the first time
-- its leave is looked at, so this migration is safe to apply while the previous version of the app is still running
-- (that version cannot read a ledger row for a leave type it does not know).
