-- CreateEnum
CREATE TYPE "HalfDayPart" AS ENUM ('FIRST', 'SECOND');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN "halfDayPart" "HalfDayPart";

-- A half-day part only makes sense on a half day. (Half days recorded before this existed simply have no part.)
ALTER TABLE "Attendance"
  ADD CONSTRAINT "attendance_half_part_only_on_half_days"
  CHECK ("halfDayPart" IS NULL OR "dayFraction" = 0.5);
