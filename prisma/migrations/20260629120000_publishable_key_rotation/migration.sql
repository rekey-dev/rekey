-- Publishable-key rotation grace window.
-- The public key is baked into shipped client bundles, so rotation is dual-key:
-- the old key moves here with a deadline and both verify until it passes.
ALTER TABLE "applications" ADD COLUMN "previous_public_key" TEXT;
ALTER TABLE "applications" ADD COLUMN "previous_public_key_valid_until" TIMESTAMP(3);

-- Unique like the live public key, so a presented key resolves to exactly one app.
CREATE UNIQUE INDEX "applications_previous_public_key_key" ON "applications"("previous_public_key");
