-- CreateTable
CREATE TABLE "contact_erasure_tombstones" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "address_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_erasure_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_erasure_tombstones_expires_at_idx" ON "contact_erasure_tombstones"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_erasure_tombstones_application_id_address_hash_key" ON "contact_erasure_tombstones"("application_id", "address_hash");

-- AddForeignKey
ALTER TABLE "contact_erasure_tombstones" ADD CONSTRAINT "contact_erasure_tombstones_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
