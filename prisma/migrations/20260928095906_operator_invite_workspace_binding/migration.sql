-- AlterTable
ALTER TABLE "operator_invites" ADD COLUMN     "email" TEXT,
ADD COLUMN     "role" "TenantRole",
ADD COLUMN     "tenant_id" TEXT;

-- CreateIndex
CREATE INDEX "operator_invites_tenant_id_idx" ON "operator_invites"("tenant_id");

-- AddForeignKey
ALTER TABLE "operator_invites" ADD CONSTRAINT "operator_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
