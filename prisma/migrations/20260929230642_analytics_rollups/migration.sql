-- CreateTable
CREATE TABLE "application_activity_days" (
    "application_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "dau" INTEGER,
    "wau" INTEGER,
    "mau" INTEGER,
    "new_users" INTEGER NOT NULL DEFAULT 0,
    "new_verified" INTEGER NOT NULL DEFAULT 0,
    "sign_ins" INTEGER NOT NULL DEFAULT 0,
    "onboarding_completed" INTEGER NOT NULL DEFAULT 0,
    "onboarding_skipped" INTEGER NOT NULL DEFAULT 0,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "usage_by_meter" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'job',
    "final" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_activity_days_pkey" PRIMARY KEY ("application_id","day")
);

-- CreateTable
CREATE TABLE "application_population_snapshots" (
    "application_id" TEXT NOT NULL,
    "taken_on" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "erased" INTEGER NOT NULL,
    "verified" INTEGER NOT NULL,
    "mfa_users" INTEGER NOT NULL,
    "passkey_users" INTEGER NOT NULL,
    "paying_users" INTEGER NOT NULL,
    "orgs" INTEGER NOT NULL,
    "users_in_org" INTEGER NOT NULL,
    "devices_active" INTEGER NOT NULL,
    "devices_blocked" INTEGER NOT NULL,
    "cube" JSONB NOT NULL DEFAULT '[]',
    "onboarding" JSONB NOT NULL DEFAULT '{}',
    "by_country" JSONB NOT NULL DEFAULT '{}',
    "by_last_via" JSONB NOT NULL DEFAULT '{}',
    "by_created_via" JSONB NOT NULL DEFAULT '{}',
    "oauth_by_provider" JSONB NOT NULL DEFAULT '{}',
    "live_sessions" JSONB NOT NULL DEFAULT '{}',
    "plan_distribution" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_population_snapshots_pkey" PRIMARY KEY ("application_id","taken_on")
);

-- AddForeignKey
ALTER TABLE "application_activity_days" ADD CONSTRAINT "application_activity_days_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_population_snapshots" ADD CONSTRAINT "application_population_snapshots_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
