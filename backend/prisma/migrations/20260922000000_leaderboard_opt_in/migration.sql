-- Leaderboard opt-in: off by default, so nobody appears on it without asking.
ALTER TABLE "UserSettings" ADD COLUMN "leaderboardOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserSettings" ADD COLUMN "leaderboardDisplayName" TEXT;
