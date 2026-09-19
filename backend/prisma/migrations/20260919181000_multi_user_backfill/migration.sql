-- Every account that exists before multi-user sign-up is an owner who already finished setup.
UPDATE "User"
SET "setupCompletedAt" = COALESCE("setupCompletedAt", now()),
    "emailVerifiedAt"  = COALESCE("emailVerifiedAt", now()),
    "isAdmin"          = true
WHERE "setupCompletedAt" IS NULL;

-- Emails are stored lower-case so "A@x.com" and "a@x.com" can never be two accounts.
UPDATE "User" SET "email" = lower("email") WHERE "email" <> lower("email");
ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "User" ADD CONSTRAINT "User_failedLogins_nonneg" CHECK ("failedLogins" >= 0);
ALTER TABLE "RateLimit" ADD CONSTRAINT "RateLimit_count_nonneg" CHECK ("count" >= 0);
-- A token is either unused or was used at/after it was created.
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_usedAt_after_created" CHECK ("usedAt" IS NULL OR "usedAt" >= "createdAt");
