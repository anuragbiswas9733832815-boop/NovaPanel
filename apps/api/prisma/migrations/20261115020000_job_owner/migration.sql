ALTER TABLE "Job" ADD COLUMN "ownerId" TEXT;
UPDATE "Job" AS j SET "ownerId" = w."ownerId" FROM "Website" AS w WHERE j."websiteId" = w."id";
CREATE INDEX "Job_ownerId_createdAt_idx" ON "Job"("ownerId", "createdAt");
ALTER TABLE "Job" ADD CONSTRAINT "Job_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
