-- DropForeignKey
ALTER TABLE "tenant_oauth_auth_codes" DROP CONSTRAINT "tenant_oauth_auth_codes_client_id_fkey";

-- AlterTable
ALTER TABLE "tenant_oauth_clients" ALTER COLUMN "redirect_uris" DROP DEFAULT;

-- CreateTable
CREATE TABLE "signing_keys" (
    "id" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "alg" TEXT NOT NULL DEFAULT 'RS256',
    "private_pem_ciphertext" TEXT NOT NULL,
    "public_pem" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signing_keys_kid_key" ON "signing_keys"("kid");

-- CreateIndex
CREATE INDEX "signing_keys_rotated_at_created_at_idx" ON "signing_keys"("rotated_at", "created_at");

-- AddForeignKey
ALTER TABLE "tenant_oauth_auth_codes" ADD CONSTRAINT "tenant_oauth_auth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "tenant_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
