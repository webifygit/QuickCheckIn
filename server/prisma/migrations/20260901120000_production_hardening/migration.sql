-- Uploaded ID images are no longer served from a public path. What we keep is an
-- opaque storage key, resolved through the storage driver behind staff auth.
ALTER TABLE "Registration" RENAME COLUMN "idDocumentImagePath" TO "idDocumentKey";

-- Records that an image existed and was purged, without keeping the image.
ALTER TABLE "Registration" ADD COLUMN "idDocumentDeletedAt" TIMESTAMP(3);

-- Who approved is already tracked; when they did was not.
ALTER TABLE "Registration" ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "Registration" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "Registration" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Registration" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "StaffUser" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StaffUser" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "StaffUser" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "StaffUser" ALTER COLUMN "updatedAt" SET NOT NULL;

-- The dashboard reads newest-first, optionally filtered by status.
CREATE INDEX "Registration_status_createdAt_idx" ON "Registration"("status", "createdAt");
CREATE INDEX "Registration_createdAt_idx" ON "Registration"("createdAt");
