-- Seed one large Application (plus 200 small ones) for the Users overview
-- load test. Run against a DISPOSABLE database only:
--
--   psql "$PERF_DATABASE_URL" -v app="$APP_ID" -v tenant="$TENANT_ID" -f seed-analytics.sql
--
-- Shape (see README.md beside this file): 500,000 end users created over 366
-- days; about 45% active in the last 60 days with a quarter of their days
-- set, which gives roughly 50k DAU and 200k MAU; 60 days of sign-in events
-- at 60,000 a day; 1.5M refresh-token rows over 30 days, 30% of them live;
-- 5% of users subscribed across 4 plans; 10M usage records over 60 days on 3
-- meters. ANALYZE at the end so the planner sees the real sizes.

\set ON_ERROR_STOP on
SET synchronous_commit = off;

-- Re-runnable: clear what an earlier run left.
DELETE FROM usage_records WHERE id LIKE 'perf_ur_%';
DELETE FROM usage_meters WHERE id LIKE 'perf_meter_%';
DELETE FROM subscriptions WHERE id LIKE 'perf_sub_%';
DELETE FROM plans WHERE id LIKE 'perf_plan_%';
DELETE FROM refresh_tokens WHERE id LIKE 'perf_rt_%';
DELETE FROM security_events WHERE id LIKE 'perf_se_%';
DELETE FROM applications WHERE id LIKE 'perf_small_%';
DELETE FROM end_users WHERE id LIKE 'perf_%';

INSERT INTO end_users (id, application_id, email, email_verified, role, created_at, updated_at,
                       last_active_on, activity_bits, last_platform, last_country, last_sign_in_via,
                       created_via, first_signed_in_at, last_signed_in_at, sign_in_count,
                       onboarding_completed_at, onboarding_skipped_at, profile, platforms_seen)
SELECT 'perf_' || g, :'app', 'perf' || g || '@example.com', r.v < 0.8, 'user', r.created, r.created,
       CASE WHEN r.active THEN current_date - r.lag END,
       CASE WHEN r.active THEN (((random() * 4611686018427387903)::bigint & (random() * 4611686018427387903)::bigint) | 1)::bit(63) END,
       (ARRAY['web', 'ios', 'android', 'macos', 'windows'])[1 + (g % 5)],
       (ARRAY['DE', 'US', 'IN', 'GB', 'FR', 'BR', 'JP', NULL])[1 + (g % 8)],
       CASE WHEN r.active THEN (ARRAY['password', 'magic_link', 'oauth', 'passkey', 'mfa'])[1 + (g % 5)] END,
       (ARRAY['password', 'magic_link', 'oauth:google', 'oauth:github', 'operator', NULL])[1 + (g % 6)],
       CASE WHEN r.active THEN r.created + interval '1 minute' END,
       CASE WHEN r.active THEN now() - (r.lag || ' days')::interval END,
       CASE WHEN r.active THEN 1 + (g % 20) ELSE 0 END,
       CASE WHEN r.v < 0.5 THEN r.created + interval '10 minutes' END,
       CASE WHEN r.v BETWEEN 0.5 AND 0.6 THEN r.created + interval '2 minutes' END,
       jsonb_build_object('team_size', (ARRAY['1', '2-10', '11+'])[1 + (g % 3)]),
       '{}'
  FROM generate_series(1, 500000) AS g,
       LATERAL (
         -- `g` is referenced so the subquery is re-evaluated per row.
         SELECT random() + 0 * g AS v,
                random() + 0 * g < 0.45 AS active,
                (floor(random() * random() * 60))::int AS lag,
                now() - random() * interval '366 days' AS created
       ) AS r;

INSERT INTO security_events (id, application_id, tenant_id, actor_type, actor_id, subject_end_user_id, type, metadata, created_at)
SELECT 'perf_se_' || g, :'app', :'tenant', 'end_user', 'perf_' || (1 + g % 500000), 'perf_' || (1 + g % 500000),
       'user.signed_in',
       jsonb_build_object('via', (ARRAY['password', 'magic_link', 'oauth', 'passkey', 'mfa'])[1 + (g % 5)]),
       now() - random() * interval '60 days'
  FROM generate_series(1, 3600000) AS g;

INSERT INTO refresh_tokens (id, session_id, application_id, end_user_id, token_hash, expires_at, created_at, revoked_at,
                            replaced_by_id, client_platform, client_os, client_browser, client_app_version)
SELECT 'perf_rt_' || g, 'perf_s_' || g, :'app', 'perf_' || (1 + (g::bigint * 7919) % 500000), 'perf_hash_' || g,
       now() + interval '30 days', now() - random() * interval '30 days',
       NULL,
       CASE WHEN g % 10 < 7 THEN 'perf_rt_' || (g + 1) END,
       (ARRAY['web', 'ios', 'android'])[1 + (g % 3)],
       (ARRAY['iOS', 'Android', 'macOS', 'Windows', NULL])[1 + (g % 5)],
       (ARRAY['Chrome', 'Safari', 'Firefox', NULL])[1 + (g % 4)],
       CASE WHEN g % 3 > 0 THEN '4.' || (g % 7) || '.0' END
  FROM generate_series(1, 1500000) AS g;

INSERT INTO plans (id, application_id, slug, name, amount, currency, interval, active, created_at, updated_at)
SELECT 'perf_plan_' || p, :'app', 'perf-' || p, 'Plan ' || p, 1000 * p, 'usd', 'MONTH', true, now(), now()
  FROM generate_series(1, 4) AS p;

INSERT INTO subscriptions (id, application_id, end_user_id, plan_id, status, created_at, updated_at)
SELECT 'perf_sub_' || g, :'app', 'perf_' || (g * 20), 'perf_plan_' || (1 + g % 4),
       (CASE WHEN g % 10 = 0 THEN 'TRIALING' WHEN g % 17 = 0 THEN 'PAST_DUE' ELSE 'ACTIVE' END)::"SubscriptionStatus",
       now() - random() * interval '300 days', now()
  FROM generate_series(1, 25000) AS g;

INSERT INTO usage_meters (id, application_id, slug, name, unit, created_at)
SELECT 'perf_meter_' || m, :'app', 'meter-' || m, 'Meter ' || m, 'call', now()
  FROM generate_series(1, 3) AS m;

INSERT INTO usage_records (id, meter_id, end_user_id, subject_key, quantity, occurred_at, created_at)
SELECT 'perf_ur_' || g, 'perf_meter_' || (1 + g % 3), 'perf_' || (1 + g % 500000), 'u:perf_' || (1 + g % 500000),
       1 + (g % 5), now() - random() * interval '60 days', now()
  FROM generate_series(1, 10000000) AS g;

-- 200 small Applications of 100 users each, so the job has many to walk.
INSERT INTO applications (id, tenant_id, name, slug, public_key, auth_config, billing_config, created_at, updated_at)
SELECT 'perf_small_' || a, :'tenant', 'Small ' || a, 'perf-small-' || a, 'rp_pub_perf_small_' || a, '{}', '{}', now(), now()
  FROM generate_series(1, 200) AS a;

INSERT INTO end_users (id, application_id, email, role, created_at, updated_at, last_active_on, activity_bits)
SELECT 'perf_small_' || a || '_' || u, 'perf_small_' || a, 'u' || u || '@example.com', 'user',
       now() - random() * interval '90 days', now(), current_date - (u % 20), 1::bigint::bit(63)
  FROM generate_series(1, 200) AS a, generate_series(1, 100) AS u;

ANALYZE;
