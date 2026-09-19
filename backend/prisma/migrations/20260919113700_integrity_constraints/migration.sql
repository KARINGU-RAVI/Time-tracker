-- Integrity rules the database enforces itself, so bugs or concurrent requests can never corrupt data.
-- (docs/01-domain-screens-er.md, section 3.4). Prisma cannot express these, hence raw SQL.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- AttendanceSession
-- ---------------------------------------------------------------------------

-- R-05: OUT must be after IN.
ALTER TABLE "AttendanceSession"
  ADD CONSTRAINT "session_out_after_in"
  CHECK ("outTime" IS NULL OR "outTime" > "inTime");

-- R-07: at most one open session per user (blocks duplicate IN and double taps).
CREATE UNIQUE INDEX "session_one_open_per_user"
  ON "AttendanceSession" ("userId")
  WHERE "outTime" IS NULL;

-- R-06: sessions of one user may never overlap. Touching ranges are allowed ('[)').
-- An open session is treated as running to infinity.
ALTER TABLE "AttendanceSession"
  ADD CONSTRAINT "session_no_overlap"
  EXCLUDE USING gist (
    "userId" WITH =,
    tstzrange("inTime", COALESCE("outTime", 'infinity'::timestamptz), '[)') WITH &&
  );

-- A session must belong to the attendance row's user, and its IN must fall on the
-- attendance date in IST (R-04: a midnight-crossing session belongs to its IN date).
CREATE FUNCTION oht_session_matches_attendance() RETURNS trigger AS $$
DECLARE
  att_user uuid;
  att_date date;
BEGIN
  SELECT "userId", "date" INTO att_user, att_date
  FROM "Attendance" WHERE "id" = NEW."attendanceId";

  IF att_user IS NULL THEN
    RAISE EXCEPTION 'Attendance % does not exist', NEW."attendanceId"
      USING ERRCODE = '23503';
  END IF;
  IF att_user <> NEW."userId" THEN
    RAISE EXCEPTION 'Session user does not match the attendance user'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW."inTime" AT TIME ZONE 'Asia/Kolkata')::date <> att_date THEN
    RAISE EXCEPTION 'Session IN time (%) is not on the attendance date % (IST)', NEW."inTime", att_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "session_matches_attendance"
  BEFORE INSERT OR UPDATE OF "attendanceId", "userId", "inTime" ON "AttendanceSession"
  FOR EACH ROW EXECUTE FUNCTION oht_session_matches_attendance();

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

-- The date and owner of an attendance row never change (sessions depend on them).
CREATE FUNCTION oht_attendance_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."date" <> OLD."date" OR NEW."userId" <> OLD."userId" THEN
    RAISE EXCEPTION 'Attendance date and user cannot be changed; create a new record instead'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attendance_identity_immutable"
  BEFORE UPDATE OF "date", "userId" ON "Attendance"
  FOR EACH ROW EXECUTE FUNCTION oht_attendance_identity_immutable();

ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_fraction_valid"
  CHECK ("dayFraction" IN (1.0, 0.5));

-- Only casual and sick leave can be a half day.
ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_half_day_only_casual_sick"
  CHECK ("dayFraction" = 1.0 OR "status" IN ('CASUAL_LEAVE', 'SICK_LEAVE'));

-- Bereavement days must be linked to an event, and only they may be.
ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_bereavement_link"
  CHECK (("status" = 'BEREAVEMENT_LEAVE') = ("bereavementEventId" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- WorkRule (R-25, R-26)
-- ---------------------------------------------------------------------------

ALTER TABLE "WorkRule"
  ADD CONSTRAINT "work_rule_week_start_valid" CHECK ("weekStartsOn" BETWEEN 1 AND 7),
  ADD CONSTRAINT "work_rule_minutes_valid" CHECK (
    "dailyRequiredMinutes" > 0
    AND "weeklyRequiredMinutes" > 0
    AND "halfDayRequiredMinutes" >= 0
    AND "halfDayRequiredMinutes" <= "dailyRequiredMinutes"
  ),
  ADD CONSTRAINT "work_rule_working_days_valid" CHECK (
    cardinality("workingDays") BETWEEN 1 AND 7
    AND "workingDays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  ),
  ADD CONSTRAINT "work_rule_dates_valid" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

-- Two rule versions of one user may not cover the same date.
ALTER TABLE "WorkRule"
  ADD CONSTRAINT "work_rule_no_overlap"
  EXCLUDE USING gist (
    "userId" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo" + 1, 'infinity'::date), '[)') WITH &&
  );

-- ---------------------------------------------------------------------------
-- LeavePolicy
-- ---------------------------------------------------------------------------

ALTER TABLE "LeavePolicy"
  ADD CONSTRAINT "leave_policy_values_valid" CHECK (
    "annualEntitlement" >= 0 AND "accrualPerMonth" >= 0 AND "carryForwardCap" >= 0
    AND "optionalQuota" >= 0 AND "bereavementDaysPerEvent" >= 0
  ),
  ADD CONSTRAINT "leave_policy_dates_valid" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "LeavePolicy"
  ADD CONSTRAINT "leave_policy_no_overlap"
  EXCLUDE USING gist (
    "userId" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo" + 1, 'infinity'::date), '[)') WITH &&
  );

-- ---------------------------------------------------------------------------
-- LeaveLedgerEntry
-- ---------------------------------------------------------------------------

-- Idempotent lazy materialisation: an accrual, grant or lapse can exist only once per date.
-- (Manual adjustments may repeat.)
CREATE UNIQUE INDEX "ledger_unique_system_entries"
  ON "LeaveLedgerEntry" ("userId", "pool", "type", "effectiveDate")
  WHERE "type" IN ('ACCRUAL', 'GRANT', 'LAPSE');

ALTER TABLE "LeaveLedgerEntry"
  ADD CONSTRAINT "ledger_leave_year_matches_date"
  CHECK ("leaveYear" = EXTRACT(YEAR FROM "effectiveDate")::int);

-- ---------------------------------------------------------------------------
-- UserSettings
-- ---------------------------------------------------------------------------

ALTER TABLE "UserSettings"
  ADD CONSTRAINT "settings_max_session_valid"
  CHECK ("maxSessionMinutes" BETWEEN 60 AND 1440);
