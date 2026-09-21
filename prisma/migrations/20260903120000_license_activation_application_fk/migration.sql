-- license_activations.application_id was added as a bare, backfilled column.
-- Every other domain row's application_id is a foreign key that cascades
-- with the Application; this one now is too, so deleting an Application
-- cannot leave activations behind (it could not in practice, since the
-- licence cascade removes them first, but the schema should say so).
ALTER TABLE "license_activations"
  ADD CONSTRAINT "license_activations_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
