-- Hosted customer portal (Portal V2): per-Application opt-in + optional custom domain + branding.
ALTER TABLE "applications" ADD COLUMN "hosted_portal_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "applications" ADD COLUMN "portal_domain" TEXT;
ALTER TABLE "applications" ADD COLUMN "portal_domain_verified_at" TIMESTAMP(3);
ALTER TABLE "applications" ADD COLUMN "portal_branding" JSONB NOT NULL DEFAULT '{}';

-- A custom portal domain maps to exactly one Application.
CREATE UNIQUE INDEX "applications_portal_domain_key" ON "applications"("portal_domain");
