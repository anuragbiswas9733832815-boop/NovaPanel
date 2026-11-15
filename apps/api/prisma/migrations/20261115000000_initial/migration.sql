CREATE TYPE "Role" AS ENUM ('ADMIN', 'CUSTOMER', 'RESELLER');
CREATE TYPE "WebsiteStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'FAILED');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "User" (
  "id" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL, "name" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'CUSTOMER', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Node" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "hostname" TEXT NOT NULL, "region" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending', "agentVersion" TEXT, "lastHeartbeat" TIMESTAMP(3),
  "cpuPercent" DOUBLE PRECISION, "memoryUsed" BIGINT, "memoryTotal" BIGINT, "diskUsed" BIGINT, "diskTotal" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Node_hostname_key" ON "Node"("hostname");

CREATE TABLE "Website" (
  "id" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "nodeId" TEXT, "primaryDomain" TEXT NOT NULL,
  "documentRoot" TEXT NOT NULL DEFAULT 'public_html', "runtime" TEXT NOT NULL DEFAULT 'static',
  "status" "WebsiteStatus" NOT NULL DEFAULT 'PENDING', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Website_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Website_primaryDomain_key" ON "Website"("primaryDomain");
CREATE INDEX "Website_ownerId_status_idx" ON "Website"("ownerId", "status");
ALTER TABLE "Website" ADD CONSTRAINT "Website_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Website" ADD CONSTRAINT "Website_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Job" (
  "id" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "type" TEXT NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED', "payload" JSONB NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "websiteId" TEXT, CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");
ALTER TABLE "Job" ADD CONSTRAINT "Job_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL, "actorId" TEXT, "action" TEXT NOT NULL, "resource" TEXT NOT NULL,
  "resourceId" TEXT, "metadata" JSONB, "ipAddress" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
