# Support mode

A state an operator puts one end-user account into, with a chosen set of
capabilities, that your app reads and acts on until an operator ends it.

## What it is

An operator opens a **support case** on an end-user. The case names one or more
**capabilities** from your Application's catalogue, covers every device or only
the ones picked, and carries a reason. While it is open the account is in
support mode, and your app can read which capabilities are on: show deeper
diagnostics, let the customer export a debug log, offer a pre-release build.

Rekey stores the state and reports it. Your app decides what each capability
means, and Rekey enforces none of them.

It is an operator action in the same family as banning a user or blocking a
device: it has a named operator, a reason, a start, an end and an audit trail.
It is not a plan, an entitlement or a grant. See
[What it is not](#what-it-is-not).

## The operator flow

In the panel:

1. **Define capabilities.** Application, Users, Support mode. Add the names
   your app understands, such as `diagnostics.debug`. A case cannot be opened
   until the catalogue has at least one.
2. **Open a case.** On the end-user, the Support mode tab. Pick capabilities,
   choose All devices or Selected devices, and write a reason. One case can be
   open per end-user.
3. **Change it.** Add or remove capabilities, narrow it to some devices or
   widen it to all. Each change is recorded.
4. **End it.** The capabilities stop being reported on your app's next read.

The same page lists every account in support mode, oldest first, with who
opened the case and how long it has been open. A case has no expiry, so that
list is what keeps one from being forgotten.

Over HTTP, with an operator session, under
`/api/v1/tenant/applications/:id`:

| Route | Body | Answer |
|---|---|---|
| `GET /end-users/:euid/support` | | `{ open, history, events }`: the open case or `null`, the last 20 closed cases newest first, and the last 50 support security events |
| `POST /end-users/:euid/support` | `{ capabilities, deviceIds?, reason }` | 201, the case |
| `PATCH /end-users/:euid/support` | `{ capabilities?, deviceIds? }` | The case |
| `POST /end-users/:euid/support/end` | | `{ case }`: the closed case, or `null` when none was open |
| `POST /end-users/:euid/support/notes` | `{ body }` | 201, the note. See [Notes](#notes) |
| `GET /support-cases?status=open\|closed&endUserId=&limit=&offset=` | | A page. Open cases come oldest first, closed cases most recently opened first. Each case has `noteCount`, not the notes |

Writes need `end-users:write` on the Application and reads need
`end-users:read`, the same access as banning. A read returns the reason to
every operator who can read end-users, as the ban read does.

On a case, `closedBy` is the operator whose action closed it: ending it, or a
ban, a delete, an erasure, a device release or a device block that closed it.
It is null while the case is open, and when the end-user or a secret key
released the last device.

The rules a write is held to:

- `capabilities` is 1 to 32 names, each in the catalogue. They are stored
  sorted, without duplicates.
- `deviceIds` when opening: left out means every device. Otherwise the case
  covers only those devices, 1 to 20, and each must be an ACTIVE device of that
  end-user. An empty list is refused.
- A device leaves the case when it stops being ACTIVE, that is when it is
  released or blocked. Unblocking it or signing in on it again does not put it
  back; change the case to add it.
- `deviceIds` when changing: left out keeps what the case covers, `null` widens
  it to every device, a non-empty list sets the devices, and an empty list is
  refused.
- `reason` is required when opening: 1 to 500 characters after trimming. It
  cannot be changed afterwards. Leaving the field out answers `BAD_REQUEST`;
  a blank or over-long one answers `SUPPORT_REASON_INVALID`.
- A banned or erased end-user cannot get a case.

## Notes

While a case is open, operators can add notes to it: what was tried, what the
customer reported, which build was sent. In the panel they are on the
end-user's Support mode tab, under the open case, and each past case is listed
there with its reason and its notes, so an operator opening a second case can
read why the earlier ones were opened and what was done.

```http
POST /api/v1/tenant/applications/:id/end-users/:euid/support/notes
{ "body": "Sent build 4.2.1, waiting for the customer to retry" }
```

- **Operators only.** Adding one needs `end-users:write`. Operators who can
  read end-users read them in `GET /end-users/:euid/support`, where each case
  carries `notes` (`id`, `body`, `authorId`, `authorEmail`, `createdAt`),
  oldest first. One response carries at most 200 notes across its cases, the
  newest ones. The end-user never sees a note.
- **Append-only.** `body` is 1 to 2000 characters after trimming. There is no
  route to edit or delete a note, and a note can only be added to the open
  case, so a closed case's notes are final.
- **Deleted with the person.** Erasing or deleting the end-user deletes the
  notes on all of their cases. The cases themselves stay.
- **Not in the export, not in webhooks.** A note is not in the end-user's data
  export, a webhook payload or security event metadata, and adding one sends
  no webhook and writes no security event. The note is the record.

A case stays open until someone ends it, and each new case starts with its own
reason and its own notes.

## Reading it from your app

### In a client, with the user's token

Add `support` to the `include` list of the current-user route:

```http
GET /api/v1/auth/me?include=support
X-Rekey-User-Token: <access token>
```

```json
{
  "support": {
    "active": true,
    "capabilities": ["diagnostics.debug"],
    "scope": "device",
    "since": "2026-10-11T09:30:00.000Z",
    "updatedAt": "2026-10-11T09:30:00.000Z"
  }
}
```

With no open case, or on a device the case does not cover, it is
`{ "active": false, "capabilities": [] }`. Nothing else in the response
changes, entitlements included. `GET /api/v1/users/me?include=support`, which
also takes your publishable or secret key, returns the same property.

`scope` is `user` when the case covers every device and `device` when it names
devices and this session's device is one of them. `since` is when the case was
opened. `updatedAt` moves on every change to an open case, so cache on that.

The answer is for the session's own device, the one in the token's `dev` claim
(see [devices.md](devices.md#binding-a-session-to-a-device)). The customer
never sees the reason or which operator opened the case.

A desktop client reading it at launch:

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
const res = await fetch(`${REKEY_URL}/api/v1/auth/me?include=support`, {
  headers: { 'X-Rekey-User-Token': accessToken },
});
const { data: me } = await res.json();

const canExportDebugLog = me.support.active && me.support.capabilities.includes('diagnostics.debug');
showSupportBanner(me.support.active);
```

### In your backend, with the secret key

```http
GET /api/v1/users/:id/support?deviceId=<device id>
Authorization: Bearer <secret key with auth:read>
```

It returns the same object. With `@rekey.dev/node`:

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

export async function uploadDiagnostics(endUserId: string, deviceId: string, bundle: Buffer): Promise<void> {
  const support = await rekey.users.getSupport(endUserId, { deviceId });
  if (!support.active || !support.capabilities.includes('diagnostics.upload')) {
    throw new Error('Diagnostic upload is not enabled for this account.');
  }
  await storeBundle(endUserId, deviceId, bundle);
}
```

A backend that already holds the user's access token can ask for it in the
call it makes anyway:
`rekey.auth.getCurrentUser(accessToken, { include: ['support'] })`.

### A case limited to devices fails closed

A case that names devices is active only where Rekey can tell the request
comes from one of them:

- A session with no device reads it as inactive. That includes browser
  sessions and impersonation tokens, which carry no device.
- On the secret-key route, leaving out `deviceId` reads only a case that covers
  every device. A case limited to devices reads as inactive.
- A `deviceId` the case does not name reads as inactive, and so does one that
  belongs to another user. The two answers are identical.

So if you scope cases to devices, bind sessions to devices and pass `deviceId`
from your backend. Otherwise the case will never read as active.

### Check valuable capabilities on your backend

A client can hide a button, but it cannot protect anything. If a capability
unlocks something that matters (a debug export with internal detail, a relaxed
limit, a recovery flow), the backend that serves it must read support mode
itself and refuse when the capability is off. Treat the client's read as what
decides the interface, never as what decides access.

There is no claim for support mode in the access token. A token can live for a
day, and a claim would keep reporting a case after it was closed. Read it from
Rekey, and cache it if you need to, as below.

## Webhooks

| Event | When |
|---|---|
| `support.opened` | An operator opened a case. |
| `support.updated` | The capabilities or devices of an open case changed: an operator edited it, or a device it named was released or blocked. |
| `support.closed` | The case closed. `data.support.closedCause` says why: `operator`, `banned`, `erased` or `device_released`. |

Each carries `data.user.id` and `data.support`, the full state after the
change: `caseId`, `active`, `capabilities`, `scope` (`USER` or `DEVICES`),
`deviceIds`, `since` and `updatedAt`. On `support.closed`, `active` is `false`,
`capabilities` is empty, and `updatedAt` is the time the case closed, so it is
newer than the `updatedAt` of every event sent before it. The reason and the operator are never sent. See
[webhooks.md](webhooks.md) for the envelope and signature.

### Invalidating a cache

Closing a case takes effect on the next read from Rekey. If your backend caches
the answer, the cache is what delays it, so drop the entry when any of the
three events arrives:

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
import { verifyWebhookSignature } from '@rekey.dev/node';

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  const ok = verifyWebhookSignature({
    header: req.headers.get('x-rekey-signature'),
    payload: raw,
    secret: process.env.REKEY_WEBHOOK_SECRET!,
  });
  if (!ok) return new Response('bad signature', { status: 401 });

  const event = JSON.parse(raw);
  if (event.type.startsWith('support.')) {
    await supportCache.deleteAllForUser(event.data.user.id);
  }
  return new Response('ok');
}
```

Delete rather than write the payload into the cache. Deliveries can arrive out
of order, and a deleted entry is refilled from Rekey with the current state. If
you do store the payload, keep it only when its `updatedAt` is newer than what
you hold. Key the cache by user and device, because the answer differs per
device, and give entries a short lifetime so a missed delivery corrects itself.

## The capability catalogue

Each Application defines its own capability names, the way it defines
application roles. A new capability is a catalogue entry, not a Rekey release.

| Route | Body | Notes |
|---|---|---|
| `GET /support-capabilities` | | The catalogue |
| `POST /support-capabilities` | `{ name, description? }` | 201 |
| `DELETE /support-capabilities/:name` | | Refused while an open case uses it |

All under `/api/v1/tenant/applications/:id`, with the same access as the case
routes.

A name matches `^[a-z0-9]+(?:[._-][a-z0-9]+)*$` and is 64 characters at most:
lowercase letters and digits, in groups separated by a single dot, hyphen or
underscore. `diagnostics.debug`, `safe_mode` and `prerelease-builds` are valid.
`Debug`, `a..b` and `.debug` are not. A catalogue holds 100 names at most.

A name is a contract with your client and backend, so it cannot be renamed,
and an entry cannot be edited. To replace one, add the new name, ship the app
that reads it, then delete the old one once no open case uses it. To change a
description, delete the entry and add it again.

Names an application might register:

| Capability | What the app does while it is on |
|---|---|
| `diagnostics.errors` | Lets the customer view and export error logs |
| `diagnostics.debug` | Lets the customer export full debug output |
| `diagnostics.upload` | Lets the client send a diagnostic bundle to support |
| `prerelease_builds` | Offers a fix build before general release |
| `safe_mode` | Starts the client with optional features off, to isolate a fault |

A level of access is a selection from the list, so "error log only" and "full
diagnostics" are two selections and not two features.

## What Rekey does without being asked

A case never expires. Rekey changes one itself only when the end-user is
banned, erased or deleted, or a device the case names is released or blocked:

| When | What happens | Webhook |
|---|---|---|
| The end-user is banned | The open case closes in the same transaction, with cause `banned` | `support.closed` |
| The end-user is erased | The open case closes in the same transaction, with cause `erased`, and the reason on every case of theirs is set to null | `support.closed` |
| The end-user is deleted (`DELETE` without `?erasure=true`) | The same as an erasure: the open case closes with cause `erased` and the reason on every case of theirs is set to null. The case rows stay, with `endUserEmail` null | `support.closed` |
| A device the case names is released or blocked | The device is removed from the case | `support.updated` |
| That device was the last one the case named | The case closes, with cause `device_released` | `support.closed` |

Releasing or blocking the last device closes the case instead of widening it to
every device. A case an operator limited to one machine never grows past it,
and a device that left the case stays out when it is unblocked or signs in
again.

Lifting a ban does not reopen a case. Open a new one.

## Security and audit

- **Operators only.** No route reachable with a publishable key or a user token
  opens, changes or ends a case. The end-user can read that support mode is on
  and which capabilities it has, and nothing more.
- **The reason stays on the case.** It is not in a webhook, not in security
  event metadata and not in the end-user's data export, and erasing or
  deleting the end-user sets it to null. Operators who can read end-users on
  the Application can read it. [Notes](#notes) follow the same rule, and are
  deleted instead of set to null.
- **Every action is a security event.** `end_user.support_opened`,
  `end_user.support_updated` and `end_user.support_closed` are written in the
  same transaction as the change, with the operator and the capabilities and
  devices before and after. They appear in the Application's activity log and
  on the end-user's Support mode tab.
- **Cases are kept after they close**, as impersonation audits are, and are
  retained on erasure as an operator-accountability record. See
  [data-erasure.md](data-erasure.md). The end-user's data export includes
  their cases as `supportCases`, without the reason.
- **Least reach.** Limit a capability that exposes detail to the one machine
  under investigation.
- **Offline verification cannot see it.** A backend that only verifies access
  tokens locally learns nothing about support mode. It has to ask Rekey.

Operators also have two MCP tools, `list_support_cases` and
`close_support_case`. Opening and changing a case is done in the panel or over
the routes above. See [mcp.md](mcp.md).

## Errors a caller should handle

| Code | Status | When |
|---|---|---|
| `SUPPORT_CASE_ALREADY_OPEN` | 409 | Opening when the end-user already has an open case. `details.caseId` names it. |
| `SUPPORT_CASE_NOT_OPEN` | 404 | Changing a case, or adding a note, when no case is open. |
| `SUPPORT_CAPABILITIES_REQUIRED` | 400 | No capabilities, or more than 32. |
| `SUPPORT_CAPABILITY_UNKNOWN` | 400 | A capability is not in the catalogue. |
| `SUPPORT_REASON_INVALID` | 400 | The reason is blank or longer than 500 characters. A request with no `reason` field answers `BAD_REQUEST` instead. |
| `SUPPORT_CASE_DEVICE_NOT_FOUND` | 404 | A device id is unknown or belongs to another end-user. |
| `SUPPORT_CASE_DEVICE_NOT_ACTIVE` | 409 | A device is released or blocked. |
| `SUPPORT_CASE_DEVICES_EMPTY` | 400 | Opening or changing sent an empty device list. |
| `SUPPORT_NOTE_INVALID` | 400 | A note is blank or longer than 2000 characters. |
| `END_USER_BANNED` | 403 | Opening a case on a banned end-user. |

The catalogue codes and how to handle each are in
[errors.md](errors.md#support-mode).

## What it is not

- **Not billing.** Opening a case touches no plan, subscription, entitlement,
  credit or licence, and resolved entitlements are the same with and without
  one. An app that wants support mode to unlock a paid feature for testing does
  that in its own code, from the capability.
- **Not a timer.** There is no expiry and no reminder. A case stays open until
  an operator ends it, which is why the panel lists open cases oldest first.
- **Not enforcement.** Rekey does not know what `diagnostics.debug` does. If
  your backend does not check a capability, nothing does.
- **Not a role.** A role says who a person is. Support mode says what state
  their account is in, with a reason, a history and a device scope.
- **Not impersonation.** Impersonation lets an operator act as the user.
  Support mode changes what the user's own client may do. Impersonation tokens
  carry no device, so they read a case limited to devices as inactive.

## Minimum version

Support mode ships in 2.2.0. An older Rekey does not know the include value and
answers `400 VALIDATION_ERROR` to `?include=support`, and `404` to the routes
above. A client that may talk to an older deployment should treat that 400 as
"support mode is off" and carry on without the include.
