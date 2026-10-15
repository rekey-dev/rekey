# `@rekey.dev/shared-types`

The Zod schemas + TypeScript types shared between the [Rekey](https://rekey.dev) API and its SDKs. Anything serialized over the wire lives here, so there's a single source of truth for every shape.

```bash
npm i @rekey.dev/shared-types
# or: pnpm add @rekey.dev/shared-types / yarn add @rekey.dev/shared-types
```

## When you need this

Most consumers **don't install this directly** — the types you'll use day-to-day are re-exported from [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node), so `import { PlanDto, RekeyError } from '@rekey.dev/node'` already works.

Reach for `@rekey.dev/shared-types` when you want the **runtime Zod schemas** (not just the static types) — e.g. to validate a payload you received out-of-band, or to share validation between your own backend and a worker without pulling in the full server SDK. It has zero deps beyond `zod`.

## Setup

No keys, no client, no env vars. Pure types + schemas — import and use.

```ts
import { PublicPlanDtoSchema, formatMoney, type PublicPlanDto } from '@rekey.dev/shared-types';

// Static type. `price` is the price the API resolved for the buyer, text included.
function priceLabel(plan: PublicPlanDto): string {
  return plan.price ? plan.price.formatted : plan.isFree ? 'Free' : 'Usage based';
}

// Runtime validation (the schema, not just the type):
export async function readPlan(res: Response): Promise<string> {
  const plan = PublicPlanDtoSchema.parse(await res.json()) as PublicPlanDto;
  return priceLabel(plan);
}

// An amount you hold yourself: an integer in the minor unit of its currency.
formatMoney(149900, 'INR'); // '₹1,499.00'
```

## What's inside

Each DTO ships as both a Zod schema (`…Schema`) and an inferred type. Highlights:

| Area | Types |
| --- | --- |
| Errors | `RekeyError` (class), `RekeyErrorShape`, `ApiResponseSchema` (the `{ success, data }` \| `{ success, error }` envelope) |
| Application config | `ApplicationDto`, `AuthConfig`, `BillingConfig`, `BillingProvider`, `AccessConfig` |
| Auth | `SignUpRequest`, `SignInRequest`, `AuthResultDto`, `SignInOutcomeDto`, `MfaChallengeResultDto`, `MfaVerifyRequest`, `ForgotPasswordRequest`, `ResetPasswordRequest`, `EndUserDto`, `ApiKeyDto` |
| Billing | `PlanDto` (operator), `PublicPlanDto` (pricing page), `PlanPriceDto`, `ResolvedPriceDto`, `PriceFallbackDto`, `PlanKindType` (`SUBSCRIPTION` / `LICENSE` / `USAGE` / `CREDIT`), `SubscriptionDto`, `CreateCheckoutRequest`, `CheckoutResultDto`, `ProvidersListDto` |
| Currencies | `formatMoney`, `minorUnitExponent`, `validatePriceAmount`, `sellableCurrencies`, `isSellableCurrency`, `currencySellability`, `chargeableStep`, `percentageDiscount`, `localCurrencyOf`, `priceFallbackMessage`, `CURRENCY_TABLE`. Also at the dependency-free `@rekey.dev/shared-types/currency` entry. |
| Money errors | `BILLING_MONEY_ERROR_CODES`, `BillingMoneyErrorCode`, `isBillingMoneyError` |
| Refunds | `RefundDto`, `CreateRefundRequest`, `RefundResultDto`, `PaymentWebhookData`, `SubscriptionWebhookData` |
| Billing log | `BillingLogEntry`, `BillingLogPage`, `BillingLogQuery`, `BillingEventType`, `BILLING_EVENT_DATA`, `BILLING_EVENT_TIER`, `ReconciliationReport`, `PriceFallbackSummary` |
| Coupons | `CouponDto`, `CouponWithStatsDto`, `CreateCouponRequest`, `UpdateCouponRequest`, `ValidateCouponRequest`, `ValidateCouponResultDto` |
| Credits | `CreditBalanceDto`, `CreditLedgerEntryDto`, `ConsumeCreditsRequest`, `ConsumeCreditsResultDto`, `GrantCreditsRequest` |
| Organizations | `OrganizationDto`, `OrganizationWithRoleDto`, `OrganizationMemberDto`, `OrganizationInvitationDto`, `OrganizationRole` |
| Licenses | `LicenseDto`, `LicenseKindType`, `LicenseVerifyResultDto` |
| Usage | `UsageRecordDto`, `UsageAggregateDto` |
| MCP / OAuth | `OAuthIntrospectionResponse`, `OAuthAuthServerMetadata`, `SecurityEventDto` |
| Outbound webhooks | `WEBHOOK_EVENTS` (the full `{ name, description }` registry), `KNOWN_WEBHOOK_EVENTS`, `WebhookEventType`, `isKnownWebhookEvent`, `WebhookEventEnvelope`(+`Schema`), `WebhookEndpointDto`, `WebhookDeliveryDto`, `RetryWebhookDeliveryResultDto` |
| Tenant / operator | `TenantPaymentDto` + `PaymentStatusType`, `BillingStatsDto` (one entry per currency in `mrr`, `revenueLast30d`, `monthlyRevenue` and `unverified`; no total across currencies), `ReportingCurrencyDto`, `RoutingPreviewDto`, `TenantEndUserDto`, `SecurityEventActorType`, query-param interfaces (`TenantPaymentsListQuery`, `TenantEndUsersListQuery`, `SecurityEventsListQuery`), `EndUserExportDocument` (GDPR/DSAR export) |

## Gotchas

- **`RekeyError` is the canonical class.** `@rekey.dev/node` and `@rekey.dev/react` re-export *this same* class, so `instanceof RekeyError` is consistent across packages. It lives in the dependency-free `@rekey.dev/shared-types/error` entry — import it from there in browser code and you get the class without zod (346 B vs 77 KB in a measured esbuild bundle). The barrel re-exports the identical class object, so either path is safe for `instanceof`.
- **Server-authored enums are open unions.** `WebhookEventType`, `SubscriptionStatusType`, `PlanKindType`, `CreditReasonType` and `PaymentStatusType` are `… | (string & {})`, because a deployment one minor version ahead sends values this package predates. The known literals still autocomplete; your `switch` needs a `default`. The closed set is exported alongside as `KnownWebhookEventType`, `KnownSubscriptionStatus`, `KnownPlanKind`, `KnownCreditReason`, `KnownPaymentStatus` — use those for registries and label maps you own, and `isKnownWebhookEvent` to narrow at runtime. Filter/query types you *send* stay closed.
- **`ApplicationDto.environment` is optional.** `GET /api/v1/me` does not return it. Narrow before use.
- **Money is integer-only**, in the minor unit of its currency. `PlanPriceDto.amount`, `CheckoutResultDto.unitAmount`, `CheckoutResultDto.discountAmount` and the rest are never floats. Write one with `formatMoney(amount, currency)`: currencies have 0, 2 or 3 decimal places, so no fixed divisor is right. Where a DTO carries `formatted`, render that.
- **Coupon discounts**: a PERCENT coupon carries `basisPoints` (`1500` = 15%). An AMOUNT coupon carries `amounts`, one `{ currency, amountOff }` per currency in that currency's smallest unit, and is refused in a currency it has no amount for.
- **Discriminated unions**: branch on the discriminator before reading fields — `SignInOutcomeDto` on `mfaRequired`, `LicenseVerifyResultDto` on `ok`.
- **`WEBHOOK_EVENTS` mirrors the API registry exactly** (names + order). Use it to render event pickers or autocomplete the `events` array when registering webhook endpoints; dedupe inbound deliveries on the envelope's `eventId`.
- **Tenant/operator DTOs describe panel-session endpoints.** `/api/v1/tenant/*` authenticates with an operator session JWT or a scoped `rp_op_…` operator token, not an Application secret key. `RekeyOperator` in `@rekey.dev/node` wraps the billing ones (prices, coupons, refunds, the billing log, stats, the routing preview). The types are here for the rest, and for panel-like consumers and agents.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)
- Server SDK that re-exports these: [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node)

## License

MIT
