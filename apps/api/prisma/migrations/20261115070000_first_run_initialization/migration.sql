ALTER TABLE "User" ADD COLUMN "username" TEXT;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

ALTER TABLE "Node" ADD COLUMN "nodeType" TEXT NOT NULL DEFAULT 'remote';
ALTER TABLE "Node" ADD COLUMN "operatingSystem" TEXT;
ALTER TABLE "Node" ADD COLUMN "cpuCores" INTEGER;
ALTER TABLE "Node" ADD COLUMN "ipAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Node" ADD COLUMN "systemInfo" JSONB;
ALTER TABLE "Node" ADD COLUMN "bootstrapIssuedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Node_single_local_key" ON "Node"("nodeType") WHERE "nodeType" = 'local';

CREATE TABLE "Installation" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
  "steps" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);
