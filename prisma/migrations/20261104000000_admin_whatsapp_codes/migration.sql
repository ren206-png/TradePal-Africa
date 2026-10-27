-- CreateTable
CREATE TABLE "AdminWhatsappFactor" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "phoneCiphertext" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "phoneLast4" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ,
    "lastUsedAt" TIMESTAMPTZ,
    "disabledAt" TIMESTAMPTZ,

    CONSTRAINT "AdminWhatsappFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminWhatsappChallenge" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "consumedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminWhatsappChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminWhatsappFactor_adminUserId_key" ON "AdminWhatsappFactor"("adminUserId");

-- CreateIndex
CREATE INDEX "AdminWhatsappFactor_phoneHash_idx" ON "AdminWhatsappFactor"("phoneHash");

-- CreateIndex
CREATE INDEX "AdminWhatsappChallenge_adminUserId_createdAt_idx" ON "AdminWhatsappChallenge"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminWhatsappChallenge_phoneHash_createdAt_idx" ON "AdminWhatsappChallenge"("phoneHash", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminWhatsappFactor" ADD CONSTRAINT "AdminWhatsappFactor_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

