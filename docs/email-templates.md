# Custom email templates

Rekey sends its own account emails (verification, password reset, magic link and the rest). Custom templates are for everything else your product mails: order shipped, invoice ready, a teammate joined. You write the email once in the panel, publish it, and your backend sends it by key with values for its variables. The subject, body and From address never travel in the send call.

## Built-in account emails

The built-in emails (password reset, email verification, magic link, welcome, two-factor enabled, password changed, payment failed) carry your Application's name and look, not Rekey's. They read the branding set in **Panel → Application → Portal**:

| Branding field | Used for |
|---|---|
| `displayName` | The name in the header, subjects, copy and footer. Falls back to the Application's name. |
| `logoUrl` | The header logo. Only an `https` URL is used; otherwise the name is shown instead. |
| `primaryColor` | The button, the accent bar and links. Only a hex colour (`#abc` or `#aabbcc`) is used; otherwise a neutral near-black. The button label switches between white and dark to stay readable. |
| `supportEmail`, `supportUrl` | The "Need help?" line in the footer. The sender identity's `supportEmail` (see [Sender identity](#sender-identity)) takes precedence over this one. Omitted when no support address or URL is set. |

Each email has an HTML part that works in dark mode and Outlook, and a plain-text part. To change one, open it in **Panel → Application → Email → Templates**: the editor opens on the default with your branding applied, and saving stores your own copy. A saved copy is sent exactly as saved, so later changes to the defaults or to your branding do not reach it. **Revert to default** deletes your copy.

Workspace invitations, unapplied-payment notices and operator sign-in emails come from Rekey itself and carry Rekey's name.

On Rekey Cloud's Free plan the built-in emails end with a small "Secured by Rekey" line linking to rekey.dev. Paid workspaces and self-hosted installs never show it, and it is never added to a template you saved.

### Variables in built-in emails

These are the `{{variables}}` a saved copy of each built-in email can use. Every date comes twice: `...AtIso` is the ISO 8601 value (`2026-09-27T14:50:00.000Z`), and the same name without `Iso` is that instant written for people, always in UTC (`27 Sep 2026, 14:50 UTC`). Templates saved before the readable form existed keep working unchanged.

| Event | Variables |
|---|---|
| `password_reset` | `userEmail`, `resetUrl`, `expiresAtIso`, `expiresAt` |
| `email_verification` | `userEmail`, `verifyUrl`, `expiresAtIso`, `expiresAt` |
| `magic_link_signin` | `userEmail`, `signInUrl`, `expiresAtIso`, `expiresAt` |
| `workspace_invitation` | `inviteeEmail`, `inviterName`, `workspaceName`, `inviteUrl`, `expiresAtIso`, `expiresAt` |
| `welcome` | `userEmail`, `appUrl` |
| `mfa_enabled` | `userEmail`, `enabledAtIso`, `enabledAt` |
| `password_changed` | `userEmail`, `changedAtIso`, `changedAt` |
| `billing_payment_failed_reminder` | `userEmail`, `planName`, `amountDue`, `attempt`, `graceEndsAtIso`, `graceEndsAt`, `portalUrl` |
| `billing_unapplied_payment` | `amount`, `provider`, `providerPaymentId`, `endUserEmail`, `receivedAtIso`, `receivedAt` |

`portalUrl` is the Application's hosted billing portal (`PUBLIC_PORTAL_URL` plus the slug), where the customer updates their payment method. It is empty when the hosted portal is off for the Application, and the default then leaves out its **Update payment method** button. Wrap a link to it in `{{#if portalUrl}}...{{/if}}` for the same effect in your own copy.
## Sender identity

Every email an Application sends, built-in or custom, introduces itself with three settings, set in **Panel → Application → Email → Sender** or with `PATCH /api/v1/tenant/applications/:id/email-sender`:

```json
{ "fromName": "Acme Support", "replyTo": "help@acme.com", "supportEmail": "support@acme.com" }
```

Only the fields you send change, and `null` or `""` clears one. They live in `emailConfig` next to the From address, and saving email credentials (`PUT .../email-credentials`) never removes them: that route sets `fromAddress`, and sets `fromName` or `replyTo` only when the body includes them.

| Field | What it does |
|---|---|
| `fromName` | The display name. With your own provider it is used as written. On the shared pool the address belongs to the deployment, so the name keeps a suffix: `Acme Support (via Rekey)`, where `Rekey` is the deployment's `RESEND_DEFAULT_FROM_NAME`. That stops any Application sending from the shared address as someone else, the deployment included. With no `fromName`, the shared pool uses the Application name with the same suffix. At most 120 characters, and a line break or any other control character is refused with `400 EMAIL_FROM_NAME_INVALID`, because in a header it would start a new one (`Bcc:` and the like). |
| `replyTo` | Sets the Reply-To header, on your own provider and on the shared pool alike. It only decides where replies go; the From line still names the sender. A value that is not one address is refused with `400 EMAIL_REPLY_TO_INVALID`. |
| `supportEmail` | Where your users can write for help. It is never sent as a header. The built-in emails show it in their "Need help?" footer line, ahead of the portal branding's `supportEmail`; with neither set, the footer falls back to the branding's `supportUrl`, or shows no help line. It is also returned as `supportEmail` on the Application (`GET /api/v1/me/`) for your own UI. A value that is not one address is refused with `400 EMAIL_SUPPORT_EMAIL_INVALID`. |

A custom template's own `fromName` (below) replaces the Application's for that template.

## Requirement: your own mail provider

Custom templates only go out through the Application's own Resend API key or SMTP server, set in **Panel → Application → Email → Settings**. They never use the shared pool, and there is no fallback to it. On an Application without its own provider you can still write drafts, but publish, test send and send all answer `403 EMAIL_TRANSPORT_NOT_CUSTOM`.

The Application also needs a From address. Each published version remembers the domain of the From address it was published for; if that domain changes later, sends of that version answer `409 EMAIL_SENDER_DOMAIN_MISMATCH` until you publish again.

## Register a template

In **Panel → Application → Email → Custom templates**, create a template. You can also use the operator API: `POST /api/v1/tenant/applications/:id/custom-email-templates`.

| Field | What it is |
|---|---|
| `key` | Permanent. 3 to 64 characters of `a-z`, `0-9` and `_`, starting with a letter. Cannot be the key of a built-in email. |
| `name` | Shown in the panel. |
| `category` | `notification` or `critical`. See [Unsubscribe and suppressions](#unsubscribe-and-suppressions). |
| `subject`, `bodyHtml`, `bodyText` | The content, with `{{variable}}` tokens and `{{#if variable}}...{{/if}}` sections. Without `bodyText`, the plain-text part is derived from the HTML and keeps link addresses. |
| `fromName` | Optional display name, over the Application's [sender name](#sender-identity). The address is always the Application's From address. |
| `variableSchema` | The variables a send may pass, up to 50. |
| `linkDomains` | Hostnames a `url` variable may point at, up to 20. Exact match. |

An Application holds at most 200 custom templates.

## Variables

Each declared variable has a `name`, a `type` and optional `required`, `maxLength` (default 256, at most 2048) and `sample`.

| Type | A send must pass |
|---|---|
| `string` | A string. |
| `number` | A finite JSON number. |
| `url` | An absolute `https` URL whose host is one of the template's `linkDomains`, with no credentials. |
| `date` | An ISO 8601 date (`2026-09-26`) or date-time with an offset. |

Values are HTML-escaped in the body. In the subject, line breaks are replaced with spaces.

A send is checked against the published version's schema, and every problem is reported at once in `details.issues` of `400 EMAIL_VARIABLES_INVALID`: a name the template does not declare, a missing required value, a value over `maxLength`, or a value of the wrong type or shape. Nothing is sent.

## Publish

Sends always use a published version, never the draft. Publishing snapshots the draft as the next version number, so editing the draft changes nothing until you publish again. A send can pin an older version with `version`.

Publish checks the content and refuses with `400 EMAIL_TEMPLATE_INVALID`, listing every problem in `details.issues`, when:

- the subject or a body uses a `{{variable}}` or `{{#if variable}}` that `variableSchema` does not declare;
- a variable that is not a `url` decides the scheme or host of a link or image address (for example `href="{{link}}"`); write the fixed address before it, or declare it as `url`;
- a variable has type `url` and the template has no link domains.

## Preview and test send

The template page shows a preview of the draft rendered with each variable's `sample` (or a typed placeholder). A variable the draft uses without declaring it is shown as its `{{name}}` token, highlighted, with a warning listing it. The operator API equivalent is `POST .../custom-email-templates/:key/preview`, which returns the rendered `subject`, `html` and `text` plus an `undeclared` list. Nothing is sent. Values passed in its optional `variables` object replace the samples and are checked exactly as a send checks them, apart from `required`, so a `url` outside the link domains is refused with `400 EMAIL_VARIABLES_INVALID`.

**Send test to me** sends the draft with sample values to the signed-in operator's own address, with `[TEST]` before the subject. It needs the Application's own provider, honours the suppression list (`409 EMAIL_ADDRESS_SUPPRESSED`) and counts toward the send caps.

## Send from your backend

Mint a secret key with the elevated **`email:send`** scope: in **Panel → Application → API Keys**, tick it under **Elevated scopes**. `*` does not include it, so a full-access key without it gets `403 API_KEY_SCOPE_INSUFFICIENT`. See [api-keys.md](api-keys.md#elevated-scopes-and-why--does-not-include-them).

With [`@rekey.dev/node`](../packages/sdk-node/README.md):

```ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

const { id, status } = await rekey.email.send({
  template: 'order_shipped',
  to: 'buyer@example.com',
  variables: { orderNumber: 'A-1042', trackingUrl: 'https://track.example.com/A-1042' },
  idempotencyKey: `order-shipped:${order.id}`,
});
```

Over HTTP this is `POST /api/v1/email/send` with the same body. It answers `202` with `status: "sent"` (and the provider's `messageId` when it returned one) or `status: "suppressed"`. The body is strict: a subject, HTML body or From address in the call is refused.

The Application setting **Only send to end users** (on the Custom templates page) makes a send to an address that is not one of the Application's end users fail with `403 EMAIL_RECIPIENT_NOT_END_USER`.

## Unsubscribe and suppressions

`notification` mail carries RFC 8058 one-click unsubscribe headers (`List-Unsubscribe` and `List-Unsubscribe-Post`), when the API has a public URL to put in them (`PUBLIC_WEBHOOK_BASE_URL` or `API_URL`). Opening the link shows a confirm page and changes nothing; the button, or a mail client's one-click POST, adds the address to the Application's suppression list for `notification` mail only. `critical` custom mail and Rekey's built-in account emails still reach that address. `critical` mail has no unsubscribe headers.

An address on the suppression list (after a bounce, a complaint, a manual entry in **Email → Suppressions**, or an unsubscribe) is not an error: the send answers `202` with `status: "suppressed"`, nothing goes out, and the attempt is logged. The same happens when all email is switched off for the Application.

## Idempotency

Pass `idempotencyKey` in the body or an `Idempotency-Key` header (1 to 200 characters; if you send both, they must match). A repeat with the same key and the same template, recipient, version and variables returns the first result and sends nothing. That includes a failed first attempt: its `502 EMAIL_DELIVERY_FAILED` is returned again, so retry a failed send with a new key.

- The same key with a different template, recipient, version or variables: `409 EMAIL_IDEMPOTENCY_KEY_REUSED`.
- The first send with the key has not finished: `409 EMAIL_SEND_IN_FLIGHT`; retry after `Retry-After`.
- The first send started more than five minutes ago and never recorded an outcome: `409 EMAIL_SEND_OUTCOME_UNKNOWN`. Check whether it arrived before sending with a new key.

## Caps

Sends are counted per workspace, across all its Applications:

- `EMAIL_SEND_DAILY_CAP` per UTC day (default 1000);
- `EMAIL_SEND_RECIPIENT_HOURLY_CAP` per recipient per hour (default 10). `+tags` in the local part count as one address.

A workspace's `limits` (`emailSendDailyCap`, `emailSendRecipientHourlyCap`) override the defaults. Over a cap the send answers `429 EMAIL_RATE_LIMITED` with `Retry-After`; nothing was sent, so the same idempotency key still works afterwards. If the cap counters are unreachable the send answers `503 DEPENDENCY_UNAVAILABLE` rather than sending uncapped.

Every error code is listed under "Email: custom templates" in [errors.md](errors.md).
