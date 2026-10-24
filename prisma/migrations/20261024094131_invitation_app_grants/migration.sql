-- CreateTable
CREATE TABLE "tenant_invitation_grants" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "role" "ApplicationGrantRole" NOT NULL,

    CONSTRAINT "tenant_invitation_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_invitation_grants_application_id_idx" ON "tenant_invitation_grants"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invitation_grants_invitation_id_application_id_key" ON "tenant_invitation_grants"("invitation_id", "application_id");

-- AddForeignKey
ALTER TABLE "tenant_invitation_grants" ADD CONSTRAINT "tenant_invitation_grants_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "tenant_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invitation_grants" ADD CONSTRAINT "tenant_invitation_grants_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
