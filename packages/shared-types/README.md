# `@relipay/shared-types`

The Zod schemas + TypeScript types shared between the [ReliPay](https://relipay.dev) API and its SDKs. Anything serialized over the wire lives here, so there's a single source of truth for every shape.

```bash
npm i @relipay/shared-types
# or: pnpm add @relipay/shared-types / yarn add @relipay/shared-types
```

## When you need this

Most consumers **don't install this directly** — the types you'll use day-to-day are re-exported from [`@relipay/node`](../sdk-node), so `import { PlanDto, RelipayError } from '@relipay/node'` already works.

Reach for `@relipay/shared-types` when you want the **runtime Zod schemas** (not just the static types) — e.g. to validate a payload you received out-of-band, or to share validation between your own backend and a worker without pulling in the full server SDK. It has zero deps beyond `zod`.

## Setup

No keys, no client, no env vars. Pure types + schemas — import and use.

```ts
import {
  RelipayError,
  PlanDtoSchema,
  type PlanDto,
  type AuthResultDto,
} from '@relipay/shared-types';

// Static type:
function priceLabel(plan: PlanDto): string {
  return `${(plan.amount / 100).toFixed(2)} ${plan.currency}`; // amount is integer cents
}

// Runtime validation (the schema, not just the type):
const plan = PlanDtoSchema.parse(await res.json());
```

## What's inside

Each DTO ships as both a Zod schema (`…Schema`) and an inferred type. Highlights:

| Area | Types |
| --- | --- |
| Errors | `RelipayError` (class), `RelipayErrorShape`, `ApiResponseSchema` (the `{ success, data }` \| `{ success, error }` envelope) |
| Application config | `ApplicationDto`, `AuthConfig`, `BillingConfig`, `BillingProvider`, `AccessConfig` |
| Auth | `SignUpRequest`, `SignInRequest`, `AuthResultDto`, `SignInOutcomeDto`, `MfaChallengeResultDto`, `MfaVerifyRequest`, `ForgotPasswordRequest`, `ResetPasswordRequest`, `EndUserDto`, `ApiKeyDto` |
| Billing | `PlanDto`, `PlanKindType` (`SUBSCRIPTION` / `LICENSE` / `USAGE` / `CREDIT`), `SubscriptionDto`, `CreateCheckoutRequest`, `CheckoutResultDto`, `ProvidersListDto` |
| Coupons | `CouponDto`, `ValidateCouponRequest`, `ValidateCouponResultDto` |
| Credits | `CreditBalanceDto`, `CreditLedgerEntryDto`, `ConsumeCreditsRequest`, `ConsumeCreditsResultDto`, `GrantCreditsRequest` |
| Organizations | `OrganizationDto`, `OrganizationWithRoleDto`, `OrganizationMemberDto`, `OrganizationInvitationDto`, `OrganizationRole` |
| Licenses | `LicenseDto`, `LicenseKindType`, `LicenseVerifyResultDto` |
| Usage | `UsageRecordDto`, `UsageAggregateDto` |
| MCP / OAuth | `OAuthIntrospectionResponse`, `OAuthAuthServerMetadata`, `SecurityEventDto` |
| Outbound webhooks | `WEBHOOK_EVENTS` (the full `{ name, description }` registry), `KNOWN_WEBHOOK_EVENTS`, `WebhookEventType`, `isKnownWebhookEvent`, `WebhookEventEnvelope`(+`Schema`), `WebhookEndpointDto`, `WebhookDeliveryDto`, `RetryWebhookDeliveryResultDto` |
| Tenant / operator | `TenantPaymentDto` + `PaymentStatusType`, `BillingStatsDto` (incl. `mrrCurrency` / `mixedCurrencies`), `TenantEndUserDto`, `SecurityEventActorType`, query-param interfaces (`TenantPaymentsListQuery`, `TenantEndUsersListQuery`, `SecurityEventsListQuery`), `EndUserExportDocument` (GDPR/DSAR export) |

## Gotchas

- **`RelipayError` is the canonical class.** `@relipay/node` and `@relipay/react` re-export *this same* class, so `instanceof RelipayError` is consistent across packages.
- **Money is integer-only**, in the smallest currency unit (cents/paise/sen). `PlanDto.amount`, `CheckoutResultDto.discountAmount`, etc. are never floats.
- **Coupon `amountOff`**: PERCENT is basis-points × 10 (`1500` = 15%); AMOUNT is the smallest currency unit.
- **Discriminated unions**: branch on the discriminator before reading fields — `SignInOutcomeDto` on `mfaRequired`, `LicenseVerifyResultDto` on `ok`.
- **`WEBHOOK_EVENTS` mirrors the API registry exactly** (names + order). Use it to render event pickers or autocomplete the `events` array when registering webhook endpoints; dedupe inbound deliveries on the envelope's `eventId`.
- **Tenant/operator DTOs describe panel-session endpoints.** `/api/v1/tenant/*` authenticates with an operator session JWT (or a scoped `rp_op_…` PAT on the small `/tenant/operator/*` surface) — not an Application secret key — so `@relipay/node` deliberately has no methods for them. The types are here for panel-like consumers and agents.

## Links

- Docs: [/docs](https://relipay.dev/docs) · [SDK guide](https://relipay.dev/docs/sdk) · [API reference](https://relipay.dev/docs/api) · [agent prompt](https://relipay.dev/docs/prompt)
- Server SDK that re-exports these: [`@relipay/node`](../sdk-node)

## License

MIT
