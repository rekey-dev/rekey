# Lifecycle email

A lifecycle email is one your product sends because of where a user is, or is not, in it: a nudge a day after sign-up for someone who has not finished setting up, a reminder before a trial ends. Rekey can hold the schedule, cancel it, honour the opt-out and keep the send log, so you do not need your own queue. This page is the order to do it in. Every field and error code is in [email-templates.md](email-templates.md).

## 1. Prepare the Application

1. Connect your own mail provider and set a From address. Custom templates never use the shared pool. See [Requirement: your own mail provider](email-templates.md#requirement-your-own-mail-provider).
2. Mint a secret key with `auth:read` and the elevated `email:send` scope, for example `["auth:read", "email:send"]`. `*` does not include `email:send`. See [Send from your backend](email-templates.md#send-from-your-backend).

## 2. Write the template with its own topic

Create a `notification` template and set `topic` (for example `onboarding`) on every template in the sequence. Unsubscribing leaves the topic, so a user who stops the nudges still gets your other notification mail, and `critical` mail and the built-in account emails always reach them. Publish it. See [Register a template](email-templates.md#register-a-template) and [Publish](email-templates.md#publish).

## 3. Schedule the send

Send with `to: { endUserId }`, a `sendAt` and an `idempotencyKey` built from the user, such as `finish-setup:<userId>`. See [Schedule a send](email-templates.md#schedule-a-send) and [Send to an end user by id](email-templates.md#send-to-an-end-user-by-id).

- `sendAt` is at most 30 days ahead and fires shortly after that time.
- Every check runs when you schedule. An unverified user is refused with `409 EMAIL_RECIPIENT_UNVERIFIED`, so schedule after the address is confirmed.
- `sendAt` is part of what an idempotency key compares. Derive it from something fixed, such as the user's `createdAt`, so a retry replays `scheduled` instead of answering `409 EMAIL_IDEMPOTENCY_KEY_REUSED`. See [Idempotency](email-templates.md#idempotency).
- When it fires, a user who left the topic or every notification email, or was suppressed or banned since, is logged `suppressed` and nothing goes out. Erasing a user deletes their scheduled sends.
- [Caps](email-templates.md#caps) are counted when it fires. A send over a cap stays scheduled and is tried again once the window has room.

## 4. Cancel it when the user acts

Read the send back by its key and cancel it, for example from the `user.onboarding_completed` [webhook](webhooks.md):

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
const { id } = await rekey.email.getSend({ idempotencyKey: `finish-setup:${userId}` });
await rekey.email.cancelSend(id);
```

`EMAIL_SEND_NOT_FOUND` means it was never scheduled, and `409 EMAIL_SEND_NOT_SCHEDULED` means it already fired or was canceled. A canceled send replays `canceled` for the same key, so use a new key to schedule it again.

## 5. Add a preferences page

`rekey.users.getEmailPreferences(userId)` and `rekey.users.updateEmailPreferences(userId, { onboarding: 'unsubscribed' })` read and write the same records as the unsubscribe link. See [Email preferences](email-templates.md#email-preferences).

## 6. Check it in CI

`rekey.email.dryRun(...)` with the template, a confirmed test user and the variables your code sends answers `would_send` or `suppressed` with the rendered email, and sends nothing. A renamed variable fails it with `400 EMAIL_VARIABLES_INVALID`. See [Dry run](email-templates.md#dry-run).

## 7. Read outcomes and listen for opt-outs

- `rekey.email.getSend({ idempotencyKey })` returns the send's `status` (`scheduled`, `canceled`, `sent`, `suppressed`, `error`, `no_transport`, `pending` or `unknown`) and `sendAt`. See [Read a send back](email-templates.md#read-a-send-back).
- The `email.unsubscribed` [webhook](webhooks.md) fires once per change, from the link or from your preferences page. `data.topic` is absent when the user left every notification email.
- Rekey does not read provider bounces or complaints. Add them under **Email → Suppressions**. See [Unsubscribe and suppressions](email-templates.md#unsubscribe-and-suppressions).
