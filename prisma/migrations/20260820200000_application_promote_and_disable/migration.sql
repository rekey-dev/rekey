-- Application lifecycle: promotion to production, and the disable switch.
-- Spec: docs/specs/app-lifecycle.md
--
-- Two changes that share one quota, and pull in opposite directions:
--
--   * `environment` stops being write-once. It becomes narrowly mutable in one
--     direction only, DEVELOPMENT|STAGING -> PRODUCTION, via an explicit
--     promote endpoint that asserts `maxProductionApps` first. Nothing else
--     writes the column and PRODUCTION is terminal. No data change is needed
--     for that here; the column already exists. What is new is the audit of
--     when it happened and who did it, which distinguishes an application that
--     was BORN production from one that was promoted into it.
--
--   * `disabled_at` is the reversible freeze that stands in for the delete we
--     do not have. A disabled Application refuses all end-user traffic at the
--     two API-key middlewares, serves no hosted portal, and dispatches no
--     webhooks or dunning mail, while every operator surface stays open so the
--     freeze can be undone. Nothing is deleted and no session is invalidated:
--     re-enabling must restore the Application to exactly the state it was
--     frozen in, so this deliberately does NOT touch `token_generation`.
--
-- The load-bearing consequence, and the reason these ship together: a disabled
-- PRODUCTION Application no longer counts against `maxProductionApps`, so the
-- ceiling is on production applications that are RUNNING rather than on
-- lifetime promotions. Re-enabling therefore re-asserts the quota and can be
-- refused. See `countProductionApps` in apps/api/src/lib/tenant-limits.ts,
-- which is the single place that predicate is allowed to live.
--
-- All five columns are nullable with no default, so this is a catalog-only
-- change: no table rewrite, no backfill, and every existing row reads as
-- "never promoted, not disabled", which is exactly what it is.

ALTER TABLE "applications" ADD COLUMN "promoted_at" TIMESTAMP(3);
ALTER TABLE "applications" ADD COLUMN "promoted_by" TEXT;
ALTER TABLE "applications" ADD COLUMN "disabled_at" TIMESTAMP(3);
ALTER TABLE "applications" ADD COLUMN "disabled_by" TEXT;
ALTER TABLE "applications" ADD COLUMN "disabled_reason" TEXT;
