-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('WORKING', 'WFH', 'CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY');

-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('COMPANY', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "LeavePool" AS ENUM ('ANNUAL', 'OPTIONAL', 'BEREAVEMENT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('OPENING', 'ACCRUAL', 'GRANT', 'LAPSE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "googleSub" TEXT,
    "name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" UUID NOT NULL,
    "trackingStartDate" DATE NOT NULL,
    "maxSessionMinutes" INTEGER NOT NULL DEFAULT 960,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'WORKING',
    "dayFraction" DECIMAL(2,1) NOT NULL DEFAULT 1.0,
    "bereavementEventId" UUID,
    "managerInformed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSession" (
    "id" UUID NOT NULL,
    "attendanceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "inTime" TIMESTAMPTZ(6) NOT NULL,
    "outTime" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dailyRequiredMinutes" INTEGER NOT NULL,
    "weeklyRequiredMinutes" INTEGER NOT NULL,
    "halfDayRequiredMinutes" INTEGER NOT NULL,
    "workingDays" INTEGER[],
    "weekStartsOn" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "type" "HolidayType" NOT NULL DEFAULT 'COMPANY',
    "description" TEXT,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "annualEntitlement" DECIMAL(5,2) NOT NULL,
    "accrualPerMonth" DECIMAL(5,2) NOT NULL,
    "carryForwardCap" DECIMAL(5,2) NOT NULL,
    "optionalQuota" DECIMAL(5,2) NOT NULL,
    "bereavementDaysPerEvent" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveLedgerEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pool" "LeavePool" NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "leaveYear" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BereavementEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "relation" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BereavementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE INDEX "Attendance_userId_date_idx" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE INDEX "AttendanceSession_attendanceId_idx" ON "AttendanceSession"("attendanceId");

-- CreateIndex
CREATE INDEX "AttendanceSession_userId_inTime_idx" ON "AttendanceSession"("userId", "inTime");

-- CreateIndex
CREATE INDEX "WorkRule_userId_effectiveFrom_idx" ON "WorkRule"("userId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Holiday_userId_date_idx" ON "Holiday"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_userId_date_key" ON "Holiday"("userId", "date");

-- CreateIndex
CREATE INDEX "LeavePolicy_userId_effectiveFrom_idx" ON "LeavePolicy"("userId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "LeaveLedgerEntry_userId_pool_effectiveDate_idx" ON "LeaveLedgerEntry"("userId", "pool", "effectiveDate");

-- CreateIndex
CREATE INDEX "BereavementEvent_userId_startDate_idx" ON "BereavementEvent"("userId", "startDate");

-- CreateIndex
CREATE INDEX "AuditLog_userId_at_idx" ON "AuditLog"("userId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_bereavementEventId_fkey" FOREIGN KEY ("bereavementEventId") REFERENCES "BereavementEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkRule" ADD CONSTRAINT "WorkRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BereavementEvent" ADD CONSTRAINT "BereavementEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
