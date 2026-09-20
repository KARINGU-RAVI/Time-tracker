-- CreateTable
CREATE TABLE "HolidayCalendarImage" (
    "userId" UUID NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fileName" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolidayCalendarImage_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "HolidayCalendarImage" ADD CONSTRAINT "HolidayCalendarImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One small picture per account: capped here as well as in the application, so the free database cannot be filled with images.
ALTER TABLE "HolidayCalendarImage"
  ADD CONSTRAINT "HolidayCalendarImage_size_capped" CHECK (octet_length("data") BETWEEN 1 AND 1048576),
  ADD CONSTRAINT "HolidayCalendarImage_type_allowed" CHECK ("mimeType" IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD CONSTRAINT "HolidayCalendarImage_dimensions_sane" CHECK ("width" BETWEEN 1 AND 10000 AND "height" BETWEEN 1 AND 10000);
