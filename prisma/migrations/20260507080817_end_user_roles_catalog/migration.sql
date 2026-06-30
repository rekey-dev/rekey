-- CreateTable
CREATE TABLE "end_user_roles" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "end_user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "end_user_roles_application_id_idx" ON "end_user_roles"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "end_user_roles_application_id_name_key" ON "end_user_roles"("application_id", "name");

-- AddForeignKey
ALTER TABLE "end_user_roles" ADD CONSTRAINT "end_user_roles_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing Application gets a default `user` role so that
-- existing EndUser.role values keep validating + new sign-ups have a target.
INSERT INTO "end_user_roles" ("id", "application_id", "name", "description", "is_default", "created_at", "updated_at")
SELECT
  'eur_' || replace(gen_random_uuid()::text, '-', ''),
  a.id,
  'user',
  'Default role assigned to public sign-ups.',
  true,
  NOW(),
  NOW()
FROM "applications" a
ON CONFLICT ("application_id", "name") DO NOTHING;

-- Backfill: any EndUser.role values currently in use that aren't 'user'
-- get a matching catalog row (so existing data validates after this migration).
INSERT INTO "end_user_roles" ("id", "application_id", "name", "description", "is_default", "created_at", "updated_at")
SELECT
  'eur_' || replace(gen_random_uuid()::text, '-', ''),
  application_id,
  role,
  'Backfilled from existing end-user data.',
  false,
  NOW(),
  NOW()
FROM (SELECT DISTINCT application_id, role FROM "end_users" WHERE role <> 'user') AS u
ON CONFLICT ("application_id", "name") DO NOTHING;
