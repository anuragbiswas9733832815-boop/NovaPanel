ALTER TABLE "Node" ADD COLUMN "agentUrl" TEXT;
ALTER TABLE "Node" ADD COLUMN "agentSecretCiphertext" TEXT;
ALTER TABLE "Node" ADD COLUMN "networkRxBytes" BIGINT;
ALTER TABLE "Node" ADD COLUMN "networkTxBytes" BIGINT;

ALTER TABLE "Job" ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Job" ADD COLUMN "lockedUntil" TIMESTAMP(3);
CREATE TABLE "AgentNonce" (
  "id" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentNonce_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentNonce_nodeId_nonce_key" ON "AgentNonce"("nodeId", "nonce");
CREATE INDEX "AgentNonce_expiresAt_idx" ON "AgentNonce"("expiresAt");
ALTER TABLE "AgentNonce" ADD CONSTRAINT "AgentNonce_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "Job_status_createdAt_idx";
CREATE INDEX "Job_status_availableAt_createdAt_idx" ON "Job"("status", "availableAt", "createdAt");
