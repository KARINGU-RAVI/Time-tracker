-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'BIRTHDAY_LEAVE';

-- AlterEnum
ALTER TYPE "LeavePool" ADD VALUE 'BIRTHDAY';

-- AlterTable
ALTER TABLE "LeavePolicy" ADD COLUMN     "birthdayQuota" DECIMAL(5,2) NOT NULL DEFAULT 0.5;
