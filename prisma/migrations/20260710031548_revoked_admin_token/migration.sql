-- CreateTable
CREATE TABLE "RevokedAdminToken" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedAdminToken_pkey" PRIMARY KEY ("jti")
);

