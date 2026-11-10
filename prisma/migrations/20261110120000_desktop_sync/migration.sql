-- CreateTable
CREATE TABLE "SyncDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SyncDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRecord" (
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "uuid" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "data" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRecord_pkey" PRIMARY KEY ("deviceId","tableName","uuid")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncDevice_keyHash_key" ON "SyncDevice"("keyHash");

-- CreateIndex
CREATE INDEX "SyncDevice_tenantId_idx" ON "SyncDevice"("tenantId");

-- CreateIndex
CREATE INDEX "SyncRecord_tenantId_tableName_updatedAt_idx" ON "SyncRecord"("tenantId", "tableName", "updatedAt");

-- AddForeignKey
ALTER TABLE "SyncDevice" ADD CONSTRAINT "SyncDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRecord" ADD CONSTRAINT "SyncRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "SyncDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

