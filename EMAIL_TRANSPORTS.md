# Report: per-application email transport — SMTP & other providers as alternatives to Resend

Status: design report / proposal. No code changed by this report.
Author: agent (workorder/dazzling-wilbur).
Scope: how to let each Application pick its email-sending transport (SMTP, SES, Postmark, SendGrid, Mailgun, …) instead of being limited to Resend.

---

## 1. Recommendation (TL;DR)

1. Introduce a **provider-discriminated** credential shape and a small `Transport` interface. Keep the existing three-tier resolution (BYO → default pool → `no_transport`); only the BYO branch becomes multi-provider.
2. Ship **generic SMTP first** (via `nodemailer`). A single SMTP transport covers Amazon SES, Postmark, SendGrid, Mailgun, Gmail/Workspace, Microsoft 365, and any self-hosted relay through their SMTP endpoints — one dependency, ~all providers. Native HTTP-API transports (SES SDK, Postmark SDK, …) are a later, optional add for deliverability features (per-message streams, native webhooks) and need not block v1.
3. **No DB migration is required.** `Application.emailCredentialsCiphertext` already stores arbitrary encrypted JSON, and `Application.emailConfig` already holds the sender identity. We extend the *decrypted shape*, not the schema. (One optional, non-secret `emailProvider` label column is discussed in §5 as a nicety, not a requirement.)
4. Treat the change as fully **backward compatible**: an existing ciphertext of `{ resend: { apiKey } }` is read as `provider: 'resend'` when no discriminator is present.

Estimated effort: ~1–1.5 days for SMTP + Resend behind the new abstraction, including panel UI and tests. Each additional native-API provider is ~half a day.

---

## 2. Current state

Email lives in two files plus one panel page and three env vars.

- Transport core — [`apps/api/src/lib/email-transport.ts`](apps/api/src/lib/email-transport.ts)
  - `EmailCredentials = { resend?: { apiKey: string } }` — the decrypted BYO shape.
  - `EmailConfig = { fromAddress?, fromName?, replyTo? }` — stored in `Application.emailConfig` (non-secret).
  - `SendOutcome = { kind:'sent'; via:'byo_resend'|'default_resend' } | { kind:'no_transport' } | { kind:'error'; message }`.
  - `sendEmail(application, input)` resolves transport **per send**, in three tiers:
    1. BYO Resend (`emailCredentialsCiphertext` decrypts to `{ resend:{ apiKey } }`) → send via the app's own Resend account using `emailConfig.fromAddress`.
    2. Else `RESEND_DEFAULT_API_KEY` + `RESEND_DEFAULT_FROM` set → ReliPay-managed pool.
    3. Else `{ kind:'no_transport' }` → auth flows fall back to returning the raw token to the API caller.
  - `sendEmailSystem(input)` — tenant-level flows (workspace invites, operator MFA) that have no `Application`; default pool only.
  - `describeTransport(application)` — returns `{ via:'byo_resend'|'default_resend'|'none', fromAddress }` for the panel status, without sending.
- Service seam — [`apps/api/src/modules/email/email.service.ts`](apps/api/src/modules/email/email.service.ts)
  - `setCredentials({ applicationId, apiKey, fromAddress, fromName?, replyTo? })` → `encryptJson({ resend:{ apiKey } })` into `emailCredentialsCiphertext`, writes `emailConfig`.
  - `removeCredentials(applicationId)` → nulls the ciphertext (reverts to default pool).
  - Templates (`EmailTemplate` rows) and the render pipeline are provider-agnostic — **no change needed**.
- Routes — [`apps/api/src/modules/email/email.routes.ts`](apps/api/src/modules/email/email.routes.ts)
  - `PUT /:id/email-credentials` ("Set or rotate the Application's BYO Resend API key + sender") and `DELETE` to revert; plus template CRUD/preview.
- Panel — [`apps/panel/src/app/(authed)/applications/[id]/email/page.tsx`](apps/panel/src/app/(authed)/applications/[id]/email/page.tsx).
- Env — `RESEND_DEFAULT_API_KEY`, `RESEND_DEFAULT_FROM`, `RESEND_DEFAULT_FROM_NAME` in [`apps/api/src/config/env.ts`](apps/api/src/config/env.ts).
- Secrets at rest — `encryptJson`/`decryptJson` in `apps/api/src/lib/secrets.ts` (AES via `ENCRYPTION_KEY`; required in prod).

The whole design is already shaped around a single `SendOutcome` so call sites don't know which transport ran. That seam is exactly the extension point.

---

## 3. Target behaviour

Per Application, an operator chooses **one** email transport in the panel:

- **Resend (API key)** — today's BYO path.
- **SMTP** — host, port, username, password, secure/STARTTLS — covers SES/Postmark/SendGrid/Mailgun/Gmail/M365/custom relay.
- *(later, optional)* native API providers: **Amazon SES**, **Postmark**, **SendGrid**, **Mailgun**.

If no BYO transport is configured, behaviour is unchanged: fall back to the ReliPay default Resend pool, then to `no_transport`.

---

## 4. Design — provider abstraction

### 4.1 Discriminated credential shape

```ts
// lib/email-transport.ts
export type EmailProvider = 'resend' | 'smtp' | 'ses' | 'postmark' | 'sendgrid' | 'mailgun';

export type EmailCredentials =
  | { provider: 'resend';   apiKey: string }
  | { provider: 'smtp';     host: string; port: number; secure: boolean; user: string; pass: string }
  | { provider: 'ses';      region: string; accessKeyId: string; secretAccessKey: string }
  | { provider: 'postmark'; serverToken: string }
  | { provider: 'sendgrid'; apiKey: string }
  | { provider: 'mailgun';  apiKey: string; domain: string; region?: 'us' | 'eu' };

// Back-compat: a legacy ciphertext is `{ resend: { apiKey } }` with no
// `provider`. Normalise on read:
function normalizeCredentials(raw: unknown): EmailCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  if (typeof o.provider === 'string') return o as EmailCredentials;     // new shape
  if (o.resend?.apiKey) return { provider: 'resend', apiKey: o.resend.apiKey }; // legacy
  return null;
}
```

`emailConfig` (`fromAddress`/`fromName`/`replyTo`) stays as-is and is shared by every provider — sender identity is orthogonal to transport.

### 4.2 Transport interface + factory

```ts
export interface Transport {
  readonly via: SentVia;                 // e.g. 'byo_smtp', 'byo_resend', ...
  send(input: SendInput, from: { address: string; name?: string; replyTo?: string }): Promise<SendOutcome>;
}

// One function per provider, all returning the same SendOutcome shape.
function makeTransport(creds: EmailCredentials): Transport { /* switch on creds.provider */ }
```

`sendEmail` collapses to:

```ts
export async function sendEmail(application, input): Promise<SendOutcome> {
  const creds = normalizeCredentials(resolveDecrypted(application));   // tier 1
  if (creds) {
    const cfg = emailConfig(application);
    if (!cfg.fromAddress) return { kind:'error', message:'…set fromAddress in Panel → Email' };
    return makeTransport(creds).send(input, { address: cfg.fromAddress, name: cfg.fromName, replyTo: cfg.replyTo });
  }
  if (env.RESEND_DEFAULT_API_KEY && env.RESEND_DEFAULT_FROM) { /* tier 2, unchanged */ }
  return { kind: 'no_transport' };                                      // tier 3, unchanged
}
```

`SendOutcome.via` widens to the union `'byo_resend' | 'byo_smtp' | 'byo_ses' | … | 'default_resend'`. `describeTransport` returns the active `provider` so the panel can show "Sending via SMTP (smtp.postmarkapp.com)".

The default-pool tier stays Resend-only on purpose: the shared pool is a ReliPay operational choice, not a per-app one. (A future `EMAIL_DEFAULT_PROVIDER`/SMTP env is trivial to add by reusing `makeTransport`, but is out of scope.)

### 4.3 SMTP transport (the high-leverage piece)

```ts
import nodemailer from 'nodemailer';

function smtpTransport(c: Extract<EmailCredentials,{provider:'smtp'}>): Transport {
  const tx = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,    // 465 => secure:true; 587 => secure:false + STARTTLS
    auth: { user: c.user, pass: c.pass },
  });
  return {
    via: 'byo_smtp',
    async send(input, from) {
      try {
        const info = await tx.sendMail({
          from: from.name ? `${from.name} <${from.address}>` : from.address,
          to: input.to, subject: input.subject, html: input.html, text: input.text,
          ...(from.replyTo ? { replyTo: from.replyTo } : {}),
        });
        return { kind:'sent', messageId: info.messageId ?? null, via:'byo_smtp' };
      } catch (e) { return { kind:'error', message:(e as Error).message }; }
    },
  };
}
```

This single transport is what makes "and other forms of email sending" cheap: SES, Postmark, SendGrid, Mailgun, Gmail, and any in-house relay all expose SMTP. Operators paste the provider's SMTP host/port/credentials and they are done — no per-provider code.

---

## 5. Data model

**No migration needed.** `emailCredentialsCiphertext` is opaque encrypted JSON; we only change the decrypted shape, and `normalizeCredentials` keeps legacy rows working.

Optional nicety (separate, additive migration if wanted): a **non-secret** `emailProvider String?` column on `Application` so the panel list / `describeTransport` can show the chosen provider without decrypting. Not required — `describeTransport` already decrypts once for status. Recommend **deferring** it; revisit only if a no-decrypt provider badge is needed on a high-traffic list view.

---

## 6. Provider matrix

| Provider | v1 via SMTP (nodemailer) | Native API later? | Notes |
|---|---|---|---|
| Resend | n/a (keep API) | already native | unchanged BYO path |
| Generic SMTP | ✅ primary | — | host/port/user/pass/secure |
| Amazon SES | ✅ (SES SMTP creds) | `@aws-sdk/client-sesv2` | SMTP is simplest; SDK adds config sets |
| Postmark | ✅ (`smtp.postmarkapp.com`) | `postmark` SDK | SDK adds message streams |
| SendGrid | ✅ (`smtp.sendgrid.net`, user `apikey`) | `@sendgrid/mail` | — |
| Mailgun | ✅ (`smtp.mailgun.org`) | `mailgun.js` | region eu/us |

Recommendation: implement **Resend + SMTP** in v1. Add a native transport only when a customer needs a provider feature SMTP can't express.

---

## 7. Validation & security

- **At rest**: SMTP password / API keys go through `encryptJson` into `emailCredentialsCiphertext`, same as today. `ENCRYPTION_KEY` is already required in production ([`config/env.ts`](apps/api/src/config/env.ts) fails closed) — so adding SMTP secrets does not weaken posture.
- **Validation** (in `setCredentials`, mirroring `billing/credentials.service.ts` style): require `host`, `1 ≤ port ≤ 65535`, non-empty `user`/`pass`; reject `fromAddress` not matching the configured sender domain only if we want strictness (Resend already errors without a verified domain). Provide a **"send test email"** action (the template-preview route already sends to a chosen address — reuse it) so operators verify creds before relying on them.
- **TLS**: default `secure:true` for port 465; for 587 use STARTTLS and set `requireTLS:true`. Do **not** expose `tls.rejectUnauthorized:false` in the UI — if added for self-signed internal relays, gate it behind an explicit "allow insecure TLS" toggle and document the risk.
- **SSRF consideration**: BYO SMTP intentionally connects to an operator-supplied `host:port`, which is an outbound connection to an arbitrary address — by design (it's their relay). This is a *different* trust model from outbound webhooks (which already have an SSRF guard + `WEBHOOK_ALLOW_PRIVATE_TARGETS`). For a hosted multi-tenant deployment, consider an optional `EMAIL_SMTP_ALLOW_PRIVATE_TARGETS` flag (default false) that blocks RFC-1918 / loopback SMTP hosts to stop an operator using ReliPay as an internal port-scanner / relay. For self-hosters this defaults open. Low priority but worth a line in the design.
- **No secret echo**: never return the stored password/API key from any GET; the panel shows only "configured" + masked provider/host, exactly as billing creds do today.

---

## 8. Panel changes

[`apps/panel/.../email/page.tsx`](apps/panel/src/app/(authed)/applications/[id]/email/page.tsx): replace the Resend-only credential form with a **provider `<select>`** that reveals provider-specific fields:

- Resend → API key.
- SMTP → host, port, secure (checkbox), username, password.
- (later) SES/Postmark/SendGrid/Mailgun → their fields.

Sender identity (`fromAddress`/`fromName`/`replyTo`) and the existing template builder are unchanged. Show the active transport from `describeTransport` ("Sending via SMTP — smtp.postmarkapp.com") and keep the "send test email" button. The `PUT /:id/email-credentials` body gains a `provider` discriminator + a zod union; `DELETE` is unchanged.

---

## 9. Backward compatibility & rollout

- Existing apps with `{ resend:{ apiKey } }` keep working via `normalizeCredentials` — no data backfill.
- `setCredentials` signature widens from `(apiKey, …)` to `(credentials: EmailCredentials, sender: {...})`; update the one route caller. The legacy "Resend key" form maps to `{ provider:'resend', apiKey }`.
- `SendOutcome.via` is a widening union — call sites that only check `kind` are unaffected; the few that log `via` keep compiling.
- Ship behind no flag — it's strictly additive (Resend stays the default-pool transport and a selectable BYO option).

---

## 10. Testing

Follow [`apps/api/test/email.test.ts`](apps/api/test/email.test.ts):

- Unit: `normalizeCredentials` (legacy vs new shape vs garbage), `describeTransport` per provider, `makeTransport` dispatch.
- SMTP: mock `nodemailer.createTransport` to assert `sendMail` args (from header, replyTo, html/text) and to simulate transport errors → `{ kind:'error' }`.
- Resend: existing tests stay green (no behaviour change on that branch).
- Fallback: no BYO + no default env → `{ kind:'no_transport' }` (the auth-flow token-return contract must not regress).

---

## 11. Dependencies

- `nodemailer` + `@types/nodemailer` (SMTP). One dependency unlocks the whole SMTP matrix.
- Optional later: `@aws-sdk/client-sesv2`, `postmark`, `@sendgrid/mail`, `mailgun.js` — add per provider only when a native feature is required.

---

## 12. Suggested phasing

1. **Phase 1 (v1, ~1–1.5d):** provider-discriminated `EmailCredentials` + `normalizeCredentials`, `Transport`/`makeTransport`, Resend + SMTP transports, widen `SendOutcome.via`, update `setCredentials` + route zod union, panel provider picker, tests. No migration.
2. **Phase 2 (optional):** native API transports (SES/Postmark/SendGrid/Mailgun) as customers ask.
3. **Phase 3 (optional):** `emailProvider` plaintext column for no-decrypt provider badges; `EMAIL_SMTP_ALLOW_PRIVATE_TARGETS` guard for hosted multi-tenant.
