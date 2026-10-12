# Currencies

Which currencies a price may be in, how an amount is stored, how it is sent to
each payment provider, and what the reporting currency does.

Related pages: [billing.md](billing.md) for plans and checkout,
[coupons.md](coupons.md) for discounts, [billing-log.md](billing-log.md) for
the record of every pricing decision, and
[migrating-to-2.2.0-rc.7.md](migrating-to-2.2.0-rc.7.md) if you are upgrading.

## An amount is an integer in the minor unit

Every amount Rekey stores, accepts and returns is an integer in the minor unit
of its currency. The minor unit is the smallest unit ISO 4217 gives the
currency: cents for USD, paise for INR, and the yen itself for JPY, which has
no smaller unit.

| You mean | Currency | You send |
|---|---|---|
| $19.99 | `USD` | `1999` |
| ₹1,499.00 | `INR` | `149900` |
| ¥5,000 | `JPY` | `5000` |
| 5,000 Ft | `HUF` | `500000` |

The number of decimal places is the currency's exponent. `minorUnitExponent`
returns it, and `formatMoney` writes an amount for a person:

```ts
import { formatMoney, minorUnitExponent } from '@rekey.dev/node';

formatMoney(1999, 'USD'); // '$19.99'
formatMoney(149900, 'INR'); // '₹1,499.00'
formatMoney(5000, 'JPY'); // '¥5,000'
formatMoney(500000, 'HUF'); // 'HUF 5,000'
formatMoney(1999, 'EUR', 'de-DE'); // '19,99 €'

minorUnitExponent('USD'); // 2
minorUnitExponent('JPY'); // 0
minorUnitExponent('XYZ'); // null: not a code Rekey knows
```

Use `formatMoney` wherever your code shows an amount. Do not keep your own
divisor or your own list of zero-decimal currencies: the exponent differs per
currency, and a fixed divisor shows a yen price a hundred times too small.
`formatMoney` throws a `RangeError` for an amount that is not a whole number,
because rounding it would show a price nobody was charged. For a code it does
not know it writes a plain two-decimal number followed by the code.

The same helpers are exported from `@rekey.dev/react` for a browser.

Where the API has already resolved a price for a buyer (a plan's `price`, a
checkout's `price`, a coupon quote), it also returns the text, as `formatted`.
Render that and format nothing yourself.

The largest amount a price or a payment can hold is 2,147,483,647 minor units.

## Which currencies a price may be in

A price may be in any currency of the sellable set. `sellableCurrencies()`
returns the list and `isSellableCurrency(code)` checks one code.

```ts
import { isSellableCurrency, sellableCurrencies } from '@rekey.dev/node';

isSellableCurrency('INR'); // true
isSellableCurrency('XAU'); // false: gold is not money
isSellableCurrency('KWD'); // false: three decimal places
sellableCurrencies().includes('USD'); // true
```

A code is left out of the sellable set for one of four reasons:

| Reason | Codes | Why |
|---|---|---|
| Not money | `XAU`, `XAG`, `XPT`, `XPD`, `XDR`, `XTS`, `XXX`, `CHE`, `CHW`, `CLF`, `MXV`, `USN` and the other ISO codes for metals, bond units, test codes and accounting units | A buyer cannot pay in them. |
| Withdrawn | `CUC`, `HRK`, `SLL`, `ZWL` | ISO 4217 has withdrawn them and no provider charges them. |
| Three decimal places | `BHD`, `IQD`, `JOD`, `KWD`, `LYD`, `OMR`, `TND` | No provider takes a three-decimal amount as written. Stripe and Razorpay accept only amounts whose last digit is 0, and PayPal takes none of them. |
| Unknown | anything else | Rekey has no record of how many decimal places it has, so it cannot scale an amount in it. |

The check runs for every price: a plan's default price, a price in another
currency, each amount of a fixed-amount coupon, and the reporting currency.
A code outside the set is refused with `PLAN_PRICE_CURRENCY_UNSUPPORTED`,
`COUPON_CURRENCY_INVALID` or `BILLING_REPORTING_CURRENCY_INVALID`
(see [errors.md](errors.md#billing-money-model)).

## Whole-unit currencies: HUF, TWD and MGA

Three currencies are sold in whole units only: the Hungarian forint (`HUF`),
the New Taiwan dollar (`TWD`) and the Malagasy ariary (`MGA`). ISO 4217 gives
each two decimal places, so an amount is still stored in hundredths, but it
must end in `00`.

The reason is that the providers disagree about these three. PayPal refuses
decimals on HUF and TWD. Stripe takes MGA with no decimals, and its subunit is
a fifth, which two decimal places cannot express. A whole-unit amount is the
one amount every provider can charge exactly.

`validatePriceAmount` applies the rule before you send a price:

```ts
import { validatePriceAmount } from '@rekey.dev/node';

validatePriceAmount('HUF', 500000); // { ok: true }: 5,000 Ft
validatePriceAmount('HUF', 500050); // { ok: false, rule: 'not_whole_unit', message: 'HUF is priced in whole units, so the amount must end in 00.' }
validatePriceAmount('USD', 19.99); // { ok: false, rule: 'not_integer', ... }
validatePriceAmount('USD', 0); // { ok: false, rule: 'not_positive', ... }
validatePriceAmount('KWD', 1000); // { ok: false, rule: 'currency_not_sellable', ... }
validatePriceAmount('USD', 3_000_000_000); // { ok: false, rule: 'too_large', ... }
```

The API runs the same check and refuses a failing price with
`PLAN_PRICE_AMOUNT_INVALID`.

The smallest difference between two chargeable amounts is therefore 100 in
these three currencies and 1 everywhere else. Discounts are computed in the
same steps, which is why a percentage coupon on a forint price takes off a
whole number of forints (see [Percentages round toward the buyer](#percentages-round-toward-the-buyer)).

## What each provider can charge

Each provider module publishes the list of currencies it can charge.
`GET /api/v1/tenant/applications/:id/billing/providers` returns it as
`supportedCurrencies`, and `operator.billing.providers()` reads it:

```ts
const { providers } = await operator.billing.providers();
for (const provider of providers) {
  const list = provider.supportedCurrencies === 'all-sellable' ? 'every sellable currency' : provider.supportedCurrencies.join(', ');
  console.log(provider.name, list);
}
```

| Provider | What it can charge | Selected for a new account |
|---|---|---|
| Stripe | The presentment currencies Stripe lists, less the three-decimal ones and the withdrawn `STD`. | All of them. Untick any your account does not charge. |
| PayPal | `AUD`, `BRL`, `CAD`, `CHF`, `CNY`, `CZK`, `DKK`, `EUR`, `GBP`, `HKD`, `HUF`, `ILS`, `JPY`, `MXN`, `MYR`, `NOK`, `NZD`, `PHP`, `PLN`, `RUB`, `SEK`, `SGD`, `THB`, `TWD`, `USD`. PayPal has no `INR`. | All of those except `BRL`, `CNY` and `MYR`, which PayPal takes from accounts in Brazil, China and Malaysia only. |
| Razorpay | The currencies in Razorpay's supported-currency table, less the three-decimal ones and the withdrawn `HRK` and `SLL`. | `INR`. The others need international payments switched on for the account. |
| External | `all-sellable`. The external provider only receives events from your own billing system and is never routed to. | All of them. |

### A provider's currencies are a list you choose

Each provider account you configure has its own `currencies` list: the
currencies that account charges. You choose them from the provider's list
above, in the panel under Billing, Setup, Providers, or with
`PUT /api/v1/tenant/applications/:id/billing-credentials/:provider`.

- A code outside the provider's list is refused when you save, with
  `BILLING_PROVIDER_CURRENCY_NOT_OFFERED`.
- An empty list means none: the provider is not used for any checkout. It no
  longer means any currency. The panel says so beside the list ("None ticked:
  this provider is not used for any checkout"), the checkout readiness check
  warns for an enabled provider with no currency, and `rekey doctor` reports
  it under `provider-currencies`.
- A provider saved for the first time without `currencies` starts with the
  list in the "Selected for a new account" column above
  (`preselectedCurrencies`, which is never empty). A later save without
  `currencies` keeps the stored list. Sending `currencies: []` stores an empty
  list, on the first save as on any other.
- A row saved by an earlier version that holds a code the provider does not
  offer still reads. The code is reported in `unsupportedCurrencies` and
  routing skips it. Remove it and save.
- A change to the list is written to the [billing log](billing-log.md) as
  `provider.currencies_changed`, with the list before and after.

The list is your statement about the account. Rekey checks it against what the
provider publishes and does not ask the provider whether your particular
account can charge each currency. If you tick a currency your account cannot
charge, the provider refuses the checkout.

To read what each configured account charges:

```ts
const rows = await operator.billing.providerCurrencies();
for (const row of rows) {
  console.log(row.provider, row.enabled, row.currencies, row.unsupportedCurrencies);
}
```

When no enabled provider lists the currency of the price selected for a buyer,
checkout charges the plan's default price instead and records why. See
[billing.md](billing.md#when-a-currency-cannot-be-charged).

## How an amount is sent to each provider

You always send and read amounts at the ISO 4217 exponent. Each provider
module converts at its own edge, because the providers do not all follow ISO.
You do not need to do anything for this to happen. The table is here so that a
figure in a provider's dashboard can be matched to a stored amount.

| Provider | What it is sent | Where it differs from the stored amount |
|---|---|---|
| Stripe | An integer. | `ISK` and `UGX` have no minor unit in ISO, and Stripe takes them as two-decimal amounts ending in 00: a stored `5000` (5,000 kr) is sent as `500000`. `MGA` has two decimals in ISO and Stripe takes it with none: a stored `150000` (1,500 Ar) is sent as `1500`. Every other currency is sent as stored. |
| PayPal | A decimal string. | `HUF`, `JPY` and `TWD` are sent with no decimal point: a stored `500000` in HUF is sent as `"5000"`. Every other currency is sent with two decimals: a stored `1999` in USD is sent as `"19.99"`. |
| Razorpay | An integer. | Nothing. Razorpay's exponent matches ISO for every currency it lists, so the stored amount is the amount sent. |

Amounts a provider reports in a webhook are converted back the same way before
they are stored or compared with a price.

A provider is never sent a rounded amount. An amount it cannot take exactly is
refused with `BILLING_AMOUNT_NOT_CHARGEABLE`, which names the provider and the
reason. With the whole-unit rule above, a price that was accepted when you
saved it does not meet this refusal.

## Percentages round toward the buyer

A percentage coupon takes `basisPoints` (hundredths of a percent: `1500` is
15%). The discount is computed in the currency charged and rounded up to the
next chargeable step, so the buyer never pays a fraction more than the rule
promises. It is never more than the price.

| Price | Coupon | Discount | Buyer pays |
|---|---|---|---|
| $19.99 (`1999`) | 15% | $3.00 (`300`), rounded up from 299.85 | $16.99 |
| $10.00 (`1000`) | 15% | $1.50 (`150`), exact | $8.50 |
| 4,990 Ft (`499000`) | 15% | 749 Ft (`74900`), rounded up from 748.50 Ft | 4,241 Ft |

Rekey computes the amount and sends the provider that amount, never the
percentage, so no provider rounds a percentage its own way. The coupon quote
returns the result as `discountAmount`, `amountAfterDiscount` and
`formatted`. See [coupons.md](coupons.md).

## The reporting currency

Each Application has one reporting currency. It is `USD` until you set it.

```ts
const current = await operator.billing.getReportingCurrency();
console.log(current.reportingCurrency, current.name); // 'USD' 'US Dollar'

await operator.billing.setReportingCurrency('EUR');
```

The HTTP routes are `GET` and `PUT
/api/v1/tenant/applications/:id/billing/reporting-currency`, with the body
`{ "reportingCurrency": "EUR" }`. Reading needs the `billing:read` scope and
writing `billing:write`. The currency must be in the sellable set, or the call
is refused with `BILLING_REPORTING_CURRENCY_INVALID`. In the panel it is under
Billing, Setup, Settings. From a terminal: `rekey billing reporting-currency
get --app <id>` and `rekey billing reporting-currency set EUR --app <id>`. On
the operator MCP server: `get_reporting_currency` and `set_reporting_currency`.

What it changes:

- It is the first entry of every per-currency list in the billing stats
  (`mrr`, `revenueLast30d`, `monthlyRevenue`), and it is present there even at
  zero.
- It is the currency offered first when you create a price or a coupon in the
  panel.
- It is the currency reported for a plan with no flat price (a free plan, a
  usage plan with no base fee).
- The change is written to the billing log as
  `settings.reporting_currency_changed`, with the value before and after.

What it does not change:

- No price, subscription, payment or coupon changes.
- Nothing is converted. Rekey has no exchange rates. A local price may be a
  purchasing-power price, so a rate would present a guess as a figure.
- There is no total across currencies. Stats are one entry per currency:

```ts
import { formatMoney } from '@rekey.dev/node';

const stats = await operator.billing.stats();

for (const row of stats.mrr) {
  console.log(row.currency, formatMoney(row.mrrCents, row.currency), row.activeSubscriptions);
}
for (const row of stats.revenueLast30d) {
  console.log(row.currency, formatMoney(row.netCents, row.currency), row.payments);
}
for (const row of stats.unverified) {
  console.log('Not applied:', formatMoney(row.amountCents, row.currency), row.payments);
}
```

`unverified` is money a provider charged that Rekey recorded and did not
apply: the charge matched no subscription, or not the price it was for. It is
in no revenue figure until you resolve it. See
[billing.md](billing.md#stats-per-currency).
