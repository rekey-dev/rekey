-- Read-only preflight for the upgrade to 2.2.0 (see docs/migrating-to-2.2.md).
-- Run against production with a read-only role. Nothing here writes.
-- Each query says what a non-empty result means and what to do about it.
--
-- PART A runs on any release from 2.1.0 on. Run it before you upgrade.
-- PART B needs tables 2.1.0 does not have. Run it as well when you are on a
-- 2.2 release candidate.
-- PART C is for after one of the `20261014*` migrations stopped and named
-- a query here: it reads columns the migrations before that one add. It also
-- runs on 2.2.0-rc.7.
--
--   psql "$READ_ONLY_DATABASE_URL" -f docs/upgrades/billing-money-model.preflight.sql
--
-- psql carries on past a query that fails, so on 2.1.0 the PART B and PART C
-- queries report a missing relation or column and can be ignored.

-- ============================== PART A ==============================

-- A1. Money stored in HUF, TWD, ISK, UGX or MGA. 2.2.0 changes how a stored
--     amount in these is sent to a provider: PayPal takes HUF and TWD in whole
--     units (stored 5000 went out as "5000" and now goes out as "50"), Stripe
--     takes ISK and UGX as two-decimal amounts (the stored value is now
--     multiplied by 100) and MGA in fifths (now divided by 100). Nothing
--     rescales these rows, and the first money migration refuses to start
--     while one exists. On a hit: for each row, work out from the provider
--     named what the buyer was really charged, then rewrite the stored amount
--     to the new scale or remove the row. Percentage coupons and free plans
--     hold no money and are not listed.
SELECT 'plans' AS source, p.id, p.application_id, p.currency, p.amount, p.slug AS detail
  FROM plans p
 WHERE p.amount > 0 AND upper(p.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'payments', pay.id, pay.application_id, pay.currency, pay.amount, pay.status::text
  FROM payments pay
 WHERE upper(pay.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'coupons', c.id, c.application_id, c.currency, c.amount_off, c.code
  FROM coupons c
 WHERE c.discount_type = 'AMOUNT' AND upper(c.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
 ORDER BY 3, 1, 2;

-- A2. Plans and fixed coupons whose currency is not a three-letter code, and
--     payments recorded in one. No price row or coupon amount can be made for
--     these, and the upgrade stops at migration price_and_coupon_column_drop_checks rather than
--     drop the amount. On a hit, before upgrading: set `currency` to the ISO
--     4217 code that was meant (UPDATE plans SET currency = 'USD' WHERE id =
--     ...), or delete a plan or coupon nobody uses. A payment row listed here
--     does not stop the upgrade; correct it so reports can total it.
SELECT 'plans' AS source, id, application_id, currency, amount FROM plans
 WHERE amount > 0 AND upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'coupons', id, application_id, currency, amount_off FROM coupons
 WHERE discount_type = 'AMOUNT' AND amount_off > 0 AND (currency IS NULL OR upper(currency) !~ '^[A-Z]{3}$')
UNION ALL
SELECT 'payments', id, application_id, currency, amount FROM payments
 WHERE upper(currency) !~ '^[A-Z]{3}$'
 ORDER BY 3, 1, 2;

-- A3. Percentage coupons whose rate is outside 0 to 10000 basis points. The
--     API has never accepted one, so a row here was written by hand. It gets
--     no rate, and the upgrade stops at migration price_and_coupon_column_drop_checks. On a hit:
--     set `amount_off` to the rate in basis points (1500 is 15 percent), or
--     delete the coupon.
SELECT id, application_id, code, amount_off FROM coupons
 WHERE discount_type = 'PERCENT' AND amount_off NOT BETWEEN 0 AND 10000;

-- A4. Plans priced in a three-decimal currency, which 2.2.0 does not sell.
--     The upgrade runs; the plan cannot be bought afterwards, and
--     `rekey doctor` reports it. On a hit: re-price the plan in a currency a
--     provider charges, or retire it.
SELECT application_id, slug, amount, currency, kind, active
  FROM plans
 WHERE amount > 0
   AND upper(currency) IN ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND');

-- A5. Plans with a per-unit price. `pricePerUnitCents` is removed from the
--     API: nothing ever charged it. The stored figure is kept, moved to the
--     plan's `metadata.pricePerUnitCents`, where nothing reads it.
--     A USAGE plan stays metered (and not free) by its kind.
--     A plan of another kind listed here at amount 0 is recorded as not free
--     and has no price row. On a hit for a kind other than USAGE: give the
--     plan a price, or clear the per-unit price before upgrading (UPDATE
--     plans SET price_per_unit_cents = NULL WHERE id = ...) so it is recorded
--     as a free plan.
SELECT application_id, slug, kind, amount, price_per_unit_cents, active
  FROM plans WHERE price_per_unit_cents IS NOT NULL;

-- A6. Provider registrations stored on plans. Save this output: after the
--     upgrade the same ids must be on each plan's default price
--     (`GET .../plans`, `prices[].registration`). Nothing to do on a hit.
SELECT p.application_id, p.slug, k.key AS provider, k.value AS registration
  FROM plans p, jsonb_each(CASE WHEN jsonb_typeof(p.metadata::jsonb) = 'object' THEN p.metadata::jsonb ELSE '{}'::jsonb END) k
 WHERE k.key IN ('stripe', 'paypal', 'razorpay')
 ORDER BY 1, 2, 3;

-- A7. Webhook endpoints stored with an http:// URL. A production deployment
--     of 2.2.0 delivers to https only, so each of these receives nothing
--     after the upgrade. On a hit: move the receiver to https and change the
--     endpoint URL, or set WEBHOOK_ALLOW_PRIVATE_TARGETS=true if the receiver
--     is on your own private network.
SELECT application_id, id, url FROM webhook_endpoints WHERE url ILIKE 'http://%';

-- A8. Applications whose `billing_config.currency` is set and is not a
--     three-letter code. It cannot become the reporting currency, and the
--     upgrade stops at migration price_and_coupon_column_drop_checks rather than drop it. On a
--     hit, before upgrading: write the ISO 4217 code that was meant,
--       UPDATE applications SET billing_config = jsonb_set(billing_config, '{currency}', '"USD"') WHERE id = '<id>';
--     or remove the key to take the default,
--       UPDATE applications SET billing_config = billing_config - 'currency' WHERE id = '<id>';
SELECT id, slug, billing_config -> 'currency' AS currency FROM applications
 WHERE jsonb_typeof(billing_config) = 'object'
   AND billing_config ? 'currency'
   AND NOT (jsonb_typeof(billing_config -> 'currency') = 'string' AND billing_config ->> 'currency' ~ '^[A-Za-z]{3}$');

-- A9. Plans whose per-unit price cannot be kept in their metadata: the
--     metadata is not a JSON object, or it already holds a different
--     `pricePerUnitCents`. The upgrade stops at migration price_and_coupon_column_drop_checks.
--     On a hit: make `metadata` an object, or correct or remove that key, or
--     clear the per-unit price if the figure is not wanted.
SELECT id, application_id, slug, price_per_unit_cents, metadata FROM plans
 WHERE price_per_unit_cents IS NOT NULL
   AND (jsonb_typeof(metadata::jsonb) IS DISTINCT FROM 'object'
        OR (metadata::jsonb ? 'pricePerUnitCents' AND metadata::jsonb -> 'pricePerUnitCents' <> to_jsonb(price_per_unit_cents)));

-- A10. Plans with a negative amount. No price row can be made for one, and
--      the upgrade stops at migration price_and_coupon_column_drop_checks rather than drop the
--      figure. On a hit: set the amount the plan really charges, or 0.
SELECT id, application_id, slug, amount, currency FROM plans WHERE amount < 0;

-- ============================== PART B ==============================

-- 1. Provider-billed subscriptions that still have no price of their own.
--    Any row here is a subscriber with no price of its own: revenue figures
--    leave them out until an operator sets one (Panel, the subscription, Set
--    price).
SELECT s.id, s.application_id, s.status, s.provider, s.provider_sub_id, p.slug, p.amount, p.currency
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
 WHERE s.currency IS NULL AND s.provider_sub_id IS NOT NULL AND s.status <> 'PENDING';

-- 2. Every other unpriced subscription on a plan that costs money: granted,
--    hand-provisioned, imported. The upgrade from a release candidate before
--    rc.7 gives these the plan's default price; nothing prices one afterwards.
SELECT s.status, coalesce(s.provider, '(none)') AS provider, p.slug, p.amount, p.currency, count(*) AS subscriptions
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
 WHERE s.currency IS NULL AND p.amount > 0
 GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC;

-- 3. Every row holding money in HUF, TWD, ISK, UGX or MGA. Version 2 changes
--    how a stored amount in these is sent to a provider: PayPal takes HUF and
--    TWD in whole units (stored 5000 went out as "5000" and now goes out as
--    "50"), Stripe takes ISK and UGX as two-decimal amounts (the stored value
--    is now multiplied by 100) and MGA in fifths (now divided by 100). Nothing
--    rescales these rows, and migration money_v2_01 refuses to start while one
--    exists. Rescale or remove each by hand, against the provider named.
SELECT 'plans' AS source, p.id, p.application_id,
       (SELECT string_agg(k.key, ',' ORDER BY k.key)
          FROM jsonb_each(CASE WHEN jsonb_typeof(p.metadata::jsonb) = 'object' THEN p.metadata::jsonb ELSE '{}'::jsonb END) k
         WHERE k.key IN ('stripe', 'paypal', 'razorpay')) AS provider,
       p.currency, p.amount, p.slug AS detail
  FROM plans p
 WHERE p.amount > 0 AND upper(p.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'plan_prices', pp.id, pp.application_id,
       (SELECT string_agg(k.key, ',' ORDER BY k.key)
          FROM jsonb_each(CASE WHEN jsonb_typeof(pp.metadata::jsonb) = 'object' THEN pp.metadata::jsonb ELSE '{}'::jsonb END) k
         WHERE k.key IN ('stripe', 'paypal', 'razorpay')),
       pp.currency, pp.amount, 'plan ' || pp.plan_id
  FROM plan_prices pp
 WHERE upper(pp.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'subscriptions', s.id, s.application_id, s.provider, s.currency, s.unit_amount, s.status::text
  FROM subscriptions s
 WHERE s.unit_amount IS NOT NULL AND upper(s.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'payments', pay.id, pay.application_id, s.provider, pay.currency, pay.amount, pay.status::text
  FROM payments pay LEFT JOIN subscriptions s ON s.id = pay.subscription_id
 WHERE upper(pay.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'checkout_sessions', cs.id, cs.application_id, cs.provider, cs.currency, cs.unit_amount, cs.status::text
  FROM checkout_sessions cs
 WHERE upper(cs.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
UNION ALL
SELECT 'coupons', c.id, c.application_id, NULL, c.currency, c.amount_off, c.code
  FROM coupons c
 WHERE c.discount_type = 'AMOUNT' AND upper(c.currency) IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
 ORDER BY 3, 1, 2;

-- 3b. Plans priced in a three-decimal currency, which version 2 will not sell.
SELECT application_id, slug, amount, currency, kind, active
  FROM plans
 WHERE amount > 0
   AND upper(currency) IN ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND');

-- 4. Usage plans at amount 0. Their per-unit price is the only thing that
--    makes them "not free" today; version 2 replaces that with an explicit flag.
SELECT application_id, slug, kind, amount, price_per_unit_cents, active
  FROM plans WHERE amount = 0 AND price_per_unit_cents IS NOT NULL;

-- 5. Payments with no subscription, and payments whose currency differs from
--    their subscription's plan. The first stay unlinked; the second cannot be
--    attached to a price automatically.
SELECT 'no subscription' AS class, count(*) FROM payments WHERE subscription_id IS NULL
UNION ALL
SELECT 'currency differs from plan', count(*)
  FROM payments pay JOIN subscriptions s ON s.id = pay.subscription_id JOIN plans p ON p.id = s.plan_id
 WHERE upper(pay.currency) <> upper(coalesce(s.currency, p.currency));

-- 6. Stored provider registrations, to compare before and after the move from
--    plans.metadata to the default price row. Save this output.
SELECT 'plan' AS source, p.application_id, p.slug, 'default' AS price, k.key AS provider, k.value AS registration
  FROM plans p, jsonb_each(p.metadata::jsonb) k
 WHERE k.key IN ('stripe', 'paypal', 'razorpay')
UNION ALL
SELECT 'price', pp.application_id, p.slug, pp.currency, k.key, k.value
  FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id, jsonb_each(pp.metadata::jsonb) k
 WHERE k.key IN ('stripe', 'paypal', 'razorpay')
 ORDER BY 2, 3, 4, 5;

-- 7. Fixed-amount coupons, and the currencies of the plans they are scoped to.
--    A coupon whose plans are sold in a currency it has no amount in will
--    refuse buyers on that price.
SELECT c.application_id, c.code, c.currency AS coupon_currency, c.amount_off, c.plan_slugs
  FROM coupons c WHERE c.discount_type = 'AMOUNT';

-- 8. Provider rows with an empty currency list, which meant "any".
SELECT application_id, provider, mode, enabled, countries, currencies
  FROM billing_credentials WHERE coalesce(cardinality(currencies), 0) = 0;

-- 9. Events with no currency in the last 90 days, by provider: how often the
--    "a charge that names no currency" rule would be exercised.
SELECT provider, event_type, count(*)
  FROM webhook_events
 WHERE received_at > now() - interval '90 days'
   AND payload::text !~* '"currency'
   AND event_type ~* 'payment|invoice|charge|sale|capture'
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- 10. Currencies that are not three letters. The migrations copy none of them:
--     such a plan gets no default price, such a coupon no amount row, and such
--     a subscription no price link, and migration price_and_coupon_column_drop_checks refuses to
--     run until each is corrected by hand. A price row listed here also fails
--     any later change to it (`plan_prices_currency_code`).
SELECT 'plans' AS source, id, application_id, currency, amount FROM plans
 WHERE amount > 0 AND upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'plan_prices', id, application_id, currency, amount FROM plan_prices
 WHERE upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'subscriptions', id, application_id, currency, unit_amount FROM subscriptions
 WHERE currency IS NOT NULL AND upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'payments', id, application_id, currency, amount FROM payments
 WHERE upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'checkout_sessions', id, application_id, currency, unit_amount FROM checkout_sessions
 WHERE currency IS NOT NULL AND upper(currency) !~ '^[A-Z]{3}$'
UNION ALL
SELECT 'coupons', id, application_id, currency, amount_off FROM coupons
 WHERE discount_type = 'AMOUNT' AND currency IS NOT NULL AND upper(currency) !~ '^[A-Z]{3}$'
 ORDER BY 3, 1, 2;

-- 11. Price rows the default-price backfill will change: one stored in another
--     case (upper-cased, and archived if the plan has the same currency live
--     twice), one in its plan's own currency at another amount (archived, the
--     plan's amount becomes the default), and one filed under another
--     Application than its plan's (moved to the plan's).
SELECT pp.id, pp.application_id, p.application_id AS plan_application_id, p.slug,
       pp.currency, pp.amount, p.currency AS plan_currency, p.amount AS plan_amount
  FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
 WHERE pp.currency <> upper(pp.currency)
    OR pp.application_id <> p.application_id
    OR (upper(pp.currency) = upper(p.currency) AND pp.amount <> p.amount);

-- 12. Subscriptions whose price belongs to another plan. Expected: none.
--     Migration subscription_price_snapshot_constraints ties a subscription's price to its own plan
--     with a foreign key, and any row here must be corrected first.
SELECT s.id, s.application_id, s.plan_id, s.plan_price_id, pp.plan_id AS price_plan_id
  FROM subscriptions s JOIN plan_prices pp ON pp.id = s.plan_price_id
 WHERE pp.plan_id <> s.plan_id;

-- ============================== PART C ==============================

-- 13. Subscriptions with some of their three price columns set and not the
--     others. Migration subscription_price_snapshot_constraints refuses to run while one exists. On
--     a hit: set all three from one of the plan's price rows, at the amount
--     the subscriber pays,
--       UPDATE subscriptions SET plan_price_id = '<plan_prices.id>', currency = '<that row's currency>', unit_amount = <amount> WHERE id = '<id>';
--     or set all three to NULL for a subscription that pays nothing.
SELECT s.id, s.application_id, s.plan_id, s.status, s.plan_price_id, s.currency, s.unit_amount
  FROM subscriptions s
 WHERE (s.currency IS NULL) <> (s.unit_amount IS NULL)
    OR (s.currency IS NULL) <> (s.plan_price_id IS NULL);

-- 14. Plans with an amount and no default price row: the usual cause is a
--     currency that is not a three-letter code, and a negative amount is
--     another. Migration plan_prices_live_on_price_rows
--     drops `plans.amount`, and refuses to while one of these would lose its
--     price. On a hit, price each by hand in the currency that was meant:
--       INSERT INTO plan_prices (id, application_id, plan_id, currency, amount, updated_at)
--         VALUES ('pp_' || md5(random()::text), '<application_id>', '<plan id>', 'USD', <amount>, now());
--       UPDATE plans SET currency = 'USD', default_price_id = (SELECT id FROM plan_prices WHERE plan_id = '<plan id>' AND currency = 'USD' AND archived_at IS NULL) WHERE id = '<plan id>';
--     or delete a plan nothing subscribes to.
SELECT id, application_id, slug, amount, currency FROM plans
 WHERE amount <> 0 AND default_price_id IS NULL;

-- 15. Plans whose own amount or currency disagrees with their default price
--     row. The API keeps the two the same, so a row here was edited in the
--     database. Only the price row is kept. On a hit: decide which is right
--     and make the other match. A plan whose amount is 0 or less has no
--     default price: set its `default_price_id` to NULL.
SELECT p.id, p.application_id, p.slug, p.amount AS plan_amount, p.currency AS plan_currency,
       dp.amount AS price_amount, dp.currency AS price_currency, dp.archived_at
  FROM plans p JOIN plan_prices dp ON dp.id = p.default_price_id
 WHERE dp.archived_at IS NULL
   AND (dp.amount <> p.amount OR dp.currency <> upper(p.currency));

-- 16. Plans whose `is_free` flag disagrees with the columns it was worked out
--     from. Same cause as 15. On a hit: set `is_free` to true on a plan that
--     charges nothing at all, and to false on every other.
SELECT id, application_id, slug, kind, amount, price_per_unit_cents, is_free FROM plans
 WHERE is_free <> (amount = 0 AND price_per_unit_cents IS NULL);

-- 17. Percentage coupons with no rate, and fixed coupons that have one.
--     Migration coupon_terms_live_on_rate_and_amount_rows drops `coupons.amount_off`. On a hit: set
--     `basis_points` on a percentage coupon (1500 is 15 percent) and to NULL
--     on a fixed one, or delete a coupon that was never usable.
SELECT id, application_id, code, discount_type, amount_off, basis_points FROM coupons
 WHERE (discount_type = 'PERCENT' AND (basis_points IS NULL OR basis_points NOT BETWEEN 0 AND 10000))
    OR (discount_type = 'AMOUNT' AND basis_points IS NOT NULL);

-- 18. Fixed coupons with an amount and no row in `coupon_amounts`: they had
--     no currency, or one that is not three letters. The API already refuses
--     them at checkout. On a hit: give each its amount in the currency it
--     discounts,
--       INSERT INTO coupon_amounts (id, application_id, coupon_id, currency, amount_off)
--         VALUES ('ca_' || md5(random()::text), '<application_id>', '<coupon id>', 'USD', <amount_off>);
--     or delete the coupon.
SELECT c.id, c.application_id, c.code, c.amount_off, c.currency FROM coupons c
 WHERE c.discount_type = 'AMOUNT' AND c.amount_off > 0
   AND NOT EXISTS (SELECT 1 FROM coupon_amounts ca WHERE ca.coupon_id = c.id);

-- 19. Applications that still have the old `currency` key in
--     `billing_config` and no three-letter `reportingCurrency` to replace it:
--     the old value was not three letters, or `reportingCurrency` is null.
--     Migration remove_billing_config_currency_key removes the old key and refuses to drop a
--     value nothing replaced. On a hit, set the code that was meant,
--       UPDATE applications SET billing_config = billing_config || jsonb_build_object('reportingCurrency', 'USD') WHERE id = '<id>';
--     or remove the old key if the default is right,
--       UPDATE applications SET billing_config = billing_config - 'currency' WHERE id = '<id>';
SELECT id, slug, billing_config -> 'currency' AS old_currency, billing_config -> 'reportingCurrency' AS reporting_currency
  FROM applications
 WHERE jsonb_typeof(billing_config) = 'object'
   AND billing_config ? 'currency'
   AND NOT (jsonb_typeof(billing_config -> 'reportingCurrency') IS NOT DISTINCT FROM 'string'
            AND billing_config ->> 'reportingCurrency' ~ '^[A-Za-z]{3}$');

-- 20. Subscriptions whose `currency` is not the currency of the price row
--     they name. The same code in another letter case is not listed: the
--     migration writes it as the price row has it. On a hit: point
--     `plan_price_id` at a price row of the same plan in the currency the
--     subscriber pays, or correct `currency`.
SELECT s.id, s.application_id, s.plan_id, s.currency, s.unit_amount, pp.id AS price_id, pp.currency AS price_currency
  FROM subscriptions s JOIN plan_prices pp ON pp.id = s.plan_price_id
 WHERE upper(s.currency) <> pp.currency;

-- 21. Plans whose default price row is archived. Nothing can be sold at an
--     archived price. On a hit: un-archive it,
--       UPDATE plan_prices SET archived_at = NULL WHERE id = '<default_price_id>';
--     or point `default_price_id` at a live row of the same plan.
SELECT p.id, p.application_id, p.slug, dp.id AS default_price_id, dp.currency, dp.amount, dp.archived_at
  FROM plans p JOIN plan_prices dp ON dp.id = p.default_price_id
 WHERE dp.archived_at IS NOT NULL;

-- 22. Plans whose per-unit price cannot be kept in their metadata: the
--     metadata is not a JSON object, or it already holds a different
--     `pricePerUnitCents`. Migration plan_prices_live_on_price_rows moves the figure there
--     before it drops the column. On a hit: make `metadata` an object, or
--     correct or remove that key, or set `price_per_unit_cents` to NULL.
SELECT id, application_id, slug, price_per_unit_cents, metadata FROM plans
 WHERE price_per_unit_cents IS NOT NULL
   AND (jsonb_typeof(metadata) IS DISTINCT FROM 'object'
        OR (metadata ? 'pricePerUnitCents' AND metadata -> 'pricePerUnitCents' <> to_jsonb(price_per_unit_cents)));

-- 23. Fixed coupons whose own `amount_off` and `currency` match none of
--     their `coupon_amounts` rows: one of the two was edited in the database.
--     Migration coupon_terms_live_on_rate_and_amount_rows drops the columns. On a hit: add the
--     missing amount row, or set `coupons.amount_off` to 0 if the rows are
--     right.
SELECT c.id, c.application_id, c.code, c.currency, c.amount_off,
       (SELECT string_agg(ca.currency || ':' || ca.amount_off, ', ' ORDER BY ca.currency) FROM coupon_amounts ca WHERE ca.coupon_id = c.id) AS amount_rows
  FROM coupons c
 WHERE c.discount_type = 'AMOUNT' AND c.amount_off > 0 AND upper(c.currency) ~ '^[A-Z]{3}$'
   AND EXISTS (SELECT 1 FROM coupon_amounts ca WHERE ca.coupon_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM coupon_amounts ca
                    WHERE ca.coupon_id = c.id AND ca.currency = upper(c.currency) AND ca.amount_off = c.amount_off);

-- 24. Percentage coupons whose `amount_off` holds a rate other than the one
--     in `basis_points`. The API writes the same rate to both, or 0 to
--     `amount_off`. On a hit: put the right rate in `basis_points`, then set
--     `amount_off` to 0.
SELECT id, application_id, code, amount_off, basis_points FROM coupons
 WHERE discount_type = 'PERCENT' AND basis_points IS NOT NULL AND amount_off <> 0 AND amount_off <> basis_points;
