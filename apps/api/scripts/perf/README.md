# Users overview load test

Manual and nightly, never per-PR CI. Run it against a disposable database.

1. Start Postgres and Redis you can throw away, migrate, and start a built API
   with rate limits on (`NODE_ENV=development`) and `ANALYTICS_ROLLUP_ENABLED=false`
   so the timer does not race the measurements.
2. `node load-analytics.mjs setup` signs up 20 operators (ADMIN in one
   workspace) and creates the Application. It writes `perf-state.json` with the
   app and tenant ids.
3. Seed: `psql "$PERF_DATABASE_URL" -v app=<appId> -v tenant=<tenantId> -f seed-analytics.sql`
   (500k users, 3.6M sign-in events, 1.5M refresh tokens, 25k subscriptions,
   10M usage records, 200 small Applications; about twenty minutes on a laptop).
4. Build the rollup for the rollup case: run `backfill-analytics-rollup` and one
   `runAnalyticsRollup` (the job's wall time for the big app is the job budget
   to check).
5. `PERF_REDIS_URL=redis://... node load-analytics.mjs run` runs each case for
   `PERF_SECONDS` (default 60) with every operator pacing itself to the route
   limit of 30 a minute, flushing `rk:an:*` before each request in the cold
   cases, and prints p50/p95/p99 per case plus the HTTP and section statuses.

Targets: cold section A live < 1.5 s, cold section B live < 3 s, cold rollup
< 300 ms, warm < 60 ms, the worst live multi-filter query < 4 s or a clean
per-section `ANALYTICS_TIMEOUT`.
