-- Data only. An empty `billing_credentials.currencies` used to mean "any
-- currency". From this release it means "none": the provider is not used for
-- any checkout. So every empty row is given the list it has in effect been
-- claiming, per provider and no wider, and no provider that takes payments
-- today stops taking them. A list that is null is treated as empty. Disabled
-- rows are filled too, so enabling one later does not bring back an empty list.
--
-- The API that ships with this migration gives a new row its provider's usual
-- currencies when none are named, so after this an empty list is one an
-- operator chose. This fill is therefore not run again in step Z: a second
-- run could not tell that choice from an old row, and would undo it.
--
-- Assumes:
--   - A Stripe account charges every currency Stripe publishes that a Rekey
--     price may be in. The list is the Stripe module's, as it stood when this
--     migration was written.
--   - A PayPal account charges PayPal's cross-border currencies. BRL, CNY and
--     MYR are for in-country accounts only and are not claimed by default.
--   - A Razorpay account charges INR, and any other currency only once
--     international payments are activated.
--   - A PayPal or Razorpay account also charges every currency it has already
--     sold in, whatever the default list says: narrowing it would refuse a
--     live subscriber's next checkout. The evidence is a subscription on that
--     provider past PENDING, or a payment that took money through it. A
--     payment's provider is its own where recorded, else its subscription's,
--     else that of a completed checkout of its subscription. Every lookup
--     stays inside the row's own Application.
--   - A currency that is not three letters is never written.
--   - Any other provider keeps what an empty list gave it: every currency a
--     Rekey price may be in, as that set stood when this migration was
--     written. That is the published list of the built-in `external` module.
--     SQL cannot read the list of a module this file does not name (a custom
--     module, or a row whose module was removed), so such a row gets the same
--     set. The API still holds each row to its module's own list when it
--     routes: a code the module cannot charge is skipped and reported as
--     unsupported, so the wide list never sends a checkout the module would
--     refuse, and it never leaves an enabled row with nothing.
--
-- Guarded by the list being empty, so a second run changes nothing and a list
-- an operator has chosen is never widened.
UPDATE "billing_credentials"
   SET "currencies" = ARRAY[
     'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BIF', 'BMD',
     'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE',
     'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GIP', 'GMD', 'GNF',
     'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JMD', 'JPY', 'KES', 'KGS', 'KHR',
     'KMF', 'KRW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT',
     'MOP', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN',
     'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SEK', 'SGD',
     'SHP', 'SLE', 'SOS', 'SRD', 'SZL', 'THB', 'TJS', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
     'UYU', 'UZS', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW'
   ]::TEXT[]
 WHERE "provider" = 'stripe'
   AND coalesce(cardinality("currencies"), 0) = 0;

UPDATE "billing_credentials" AS bc
   SET "currencies" = ARRAY(
     SELECT DISTINCT sold."currency" FROM (
       SELECT unnest(
         CASE bc."provider"
           WHEN 'paypal' THEN ARRAY[
             'AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'MXN', 'NOK', 'NZD', 'PHP',
             'PLN', 'RUB', 'SEK', 'SGD', 'THB', 'TWD', 'USD'
           ]::TEXT[]
           ELSE ARRAY['INR']::TEXT[]
         END
       ) AS "currency"
       UNION ALL
       SELECT upper(s."currency")
         FROM "subscriptions" AS s
        WHERE s."application_id" = bc."application_id"
          AND s."provider" = bc."provider"
          AND s."status" <> 'PENDING'
          AND s."currency" IS NOT NULL
       UNION ALL
       SELECT upper(pay."currency")
         FROM "payments" AS pay
         LEFT JOIN "subscriptions" AS s
           ON s."id" = pay."subscription_id" AND s."application_id" = bc."application_id"
        WHERE pay."application_id" = bc."application_id"
          AND pay."status" IN ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED')
          AND coalesce(
                pay."provider",
                s."provider",
                (SELECT cs."provider" FROM "checkout_sessions" AS cs
                  WHERE cs."application_id" = bc."application_id"
                    AND cs."subscription_id" = pay."subscription_id"
                    AND cs."status" = 'COMPLETE'
                  ORDER BY cs."created_at" DESC, cs."id" DESC
                  LIMIT 1)
              ) = bc."provider"
     ) AS sold
     WHERE sold."currency" ~ '^[A-Z]{3}$'
     ORDER BY sold."currency"
   )
 WHERE bc."provider" IN ('paypal', 'razorpay')
   AND coalesce(cardinality(bc."currencies"), 0) = 0;

UPDATE "billing_credentials"
   SET "currencies" = ARRAY[
     'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BIF',
     'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP',
     'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP',
     'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR',
     'ISK', 'JMD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
     'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
     'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON',
     'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN',
     'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU',
     'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG'
   ]::TEXT[]
 WHERE "provider" NOT IN ('stripe', 'paypal', 'razorpay')
   AND coalesce(cardinality("currencies"), 0) = 0;
