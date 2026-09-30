# Lists

A list collects people who asked to hear from you before, or without, having an
account: a waitlist, a newsletter, a contact form. Rekey stores who joined, what
they agreed to and what they typed, and hands it to you through webhooks and the
API. Rekey sends no email to a list.

## Concepts

- **List**: belongs to one Application and is named by a permanent `key`
  (`^[a-z][a-z0-9_]{2,63}$`, for example `waitlist`). Its `kind` (`newsletter`,
  `waitlist`, `contact_form`, `generic`) only changes panel copy.
- **Contact**: one per address per Application, shared by every list in it. A
  contact and an end user are the same person when the address matches; nothing
  links them otherwise.
- **Member**: a contact on one list, `subscribed` or `unsubscribed`, with the
  consent proof: the consent text version, when, and the visitor's network
  (IPv4 /24 or IPv6 /48, never the full address).
- **Submission**: the `fields` one subscribe carried, for example a contact
  form message. Append-only.

## Setting up a list

In the panel, open the Application, then Audience, and choose New list. The
list's header shows at a glance whether it is active or archived, whether
Public capture is on and from which sites, its consent version and how long
submissions are kept, with Archive or Restore next to it (both ask first).
Each list has four tabs: Members (with the consent proof, search, and
Unsubscribe), Submissions, Settings (Public capture, fields, consent text and
its history, retention, archiving) and Embed (copy-paste code filled in with
the list's key, fields and consent version). Export CSV on Members needs the OWNER or
ADMIN workspace role and is recorded as `app.contacts_exported`.

Or with the operator API:

```bash
curl -X POST "$REKEY_URL/api/v1/tenant/applications/$APP_ID/lists" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"waitlist","name":"Waitlist","kind":"waitlist",
       "lawfulBasis":"consent","consentText":"Email me when it launches."}'
```

- `lawfulBasis` is `consent` (the default), `legitimate_interest` or
  `contract`. On a `consent` list every subscribe must say the person agreed.
- `consentText` is versioned. Each new text gets the next `consentVersion` and
  the old ones stay in the list's history, so a member's `consentVersion`
  always names the words they saw.
- `fieldSchema` declares extra fields: `text`, `textarea`, `email`, `url`,
  `select` (with `options`), `checkbox`, `number`, each with `required` and
  `maxLength` (default 500). At most 20.
- `blockDisposable` (default on) refuses addresses at disposable domains.

Operators need the `audience` scope. Workspace owners and admins and
`APP_ADMIN` grants hold it; viewer and billing grants never do. The operator
routes for one list are `GET .../lists/:listId/members` (search, status
filter), `GET .../lists/:listId/submissions`,
`POST .../lists/:listId/members/:memberId/unsubscribe`, and the
`GET .../lists/:listId/export.csv` floor route. An operator can take someone
off a list but never add them back.

## Subscribing someone

One route, `POST /api/v1/lists/:key/subscribe`, for both key types.

**From your server, relaying a form** (recommended), with a secret key. `*`
includes the `contacts:write` scope it needs. Send the visitor's address in
`X-Rekey-Client-Ip`:

```bash
curl -X POST "$REKEY_URL/api/v1/lists/waitlist/subscribe" \
  -H "Authorization: Bearer $REKEY_SECRET" -H 'Content-Type: application/json' \
  -H "X-Rekey-Client-Ip: $VISITOR_IP" \
  -d '{"email":"ada@example.com","consent":{"granted":true,"version":1}}'
# → 202 { "data": { "status": "received" } }
```

A call that names a visitor is treated as the browser it relays: what the page
posted is a stranger's input, so it gets the browser rules and the browser's
constant answer, and the rate limits and consent proof are about that visitor.
Pass the answer on as it is; never tell the page more.

Also send `X-Rekey-Relay: browser` on every relayed call. A call carrying it is
treated as a browser even when the visitor address is missing or unreadable,
so a relay can never fall through to the server's own powers; without an
address it is held by the per-list and daily limits. The SDK helpers
(`subscribeToList`) send it for you.

**From your server, for itself** (an import, an admin tool, your own sign-up
flow), leave `X-Rekey-Client-Ip` and `X-Rekey-Relay` out. Only such a call gets what happened:
`subscribed`, `already_subscribed`, `previously_unsubscribed`, `suppressed`
(the address bounced, complained or was blocked, and nothing was stored) or
`ignored` (the honeypot was filled). Only it may rename a contact, add back
someone who left (with `consent`), or add an address whose only suppression is
a notification opt-out. Keep it off any path a visitor can reach.

**From a browser**, with the publishable key. The list needs Public capture
on, and the Application needs at least one browser origin in Access; turning
Public capture on is refused with `LIST_CAPTURE_UNPROTECTED` until it has one.
An origin stops other websites from using your key. It does not stop scripts,
which the rate limits hold instead.

A browser always gets `202 {"status":"received"}`, whatever happened, so the
route cannot be used to find out who is on a list.

Fetch the form first. `GET /api/v1/lists/:key` returns the fields and the
consent text and version to show:

```json
{ "key": "waitlist", "name": "Waitlist", "kind": "waitlist", "fieldSchema": [],
  "consent": { "text": "Email me when it launches.", "version": 1, "lawfulBasis": "consent" } }
```

### The body

| Field | |
|---|---|
| `email` | Required. Stored lowercased. |
| `name` | Optional. A browser can fill in a missing name but never change one. |
| `fields` | Values for the list's `fieldSchema`. Stored as a submission. 8 KB in total. |
| `consent` | `{ "granted": true, "version": N }`. Required on a `consent` list; `N` must be the current version or the call is refused with `CONTACT_CONSENT_STALE`. |
| `sourceUrl` | The page the form was on. Only the origin and path are kept. |
| `hp` | Honeypot. Render it hidden; a filled one stores nothing. |

### Who can add someone back

A browser, or your server relaying one, can never re-subscribe someone who
unsubscribed, and can never change a contact's name once it is set: anyone can
type anyone's address into a public form. Only your server speaking for itself
can, with a call that carries `consent`.

### Suppressed addresses

An address with any suppression (a bounce, a complaint, a manual block, or a
one-click opt-out from notification mail) is never captured from a browser or
a relayed form: the call answers as usual and stores nothing. Your server,
speaking for itself, can still add an address whose only suppression is the
notification opt-out.

Addresses are compared after trimming and lowercasing only. `ada+news@x.com`
and `ada@x.com`, or Gmail's dotted variants, are different addresses to lists
and to suppressions.

### Limits

- Browser subscribes (a publishable key, or a secret key sending
  `X-Rekey-Client-Ip`): 5 a minute and 30 an hour per visitor address, and 120
  a minute per list. Over it: `429 CONTACTS_RATE_LIMITED`.
- A secret key with no visitor address: 1200 a minute per list.
- `Tenant.limits.contactCaptureDailyCap`: browser subscribes per UTC day across
  the workspace.
- `Tenant.limits.maxContacts`: counted only when a subscribe would add a new
  contact, and counted under a per-workspace lock so concurrent subscribes
  cannot pass it. Your server speaking for itself is refused with
  `CONTACT_QUOTA_EXCEEDED`. A browser or relayed form still gets its `202`,
  nothing is stored, and the workspace gets an
  `app.contact_quota_reached` security event at most once an hour.
- `Tenant.limits.maxContactLists`: lists that are not archived.

Null or absent limits mean unlimited, which is every self-hosted workspace.

## Reading members out

Rekey sends no email to a list: read the members and hand them to your email
tool. `GET /api/v1/lists/:key/members` needs a key minted with the elevated
`contacts:read` scope (`*` does not include it, because it reads out every
address). Members come oldest change first, paged with `cursor`. To sync, store
the last `updatedAt` you saw and pass it as `updatedSince` next time; ask for
`status=all` to hear about unsubscribes too.

```ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_EXPORT_KEY! });
for await (const m of rekey.lists.iterateMembers('waitlist', { status: 'all', updatedSince: lastSync })) {
  await emailTool.upsert(m.email, m.status);
}
```

Or from a shell, with the same key in `REKEY_SECRET`:

```bash
rekey lists ls
rekey lists export waitlist --format csv --out waitlist.csv
```

`GET /api/v1/lists` (any `*` key) lists the lists with their counts, never
addresses.

## React components

`@rekey.dev/react` has `<NewsletterForm list="waitlist" />`, `<ContactForm
list="contact" />` (it renders the list's fields) and the `useListSubscribe`
hook. Without an `action` prop they subscribe from the browser with the
publishable key, which needs Public capture. Pass `action` (your Server Action)
and `form` (from `rekey.lists.get(key)` on your server) to keep Public capture
off. See [react-components.md](react-components.md#list-forms).

## From a Next.js server action

`@rekey.dev/nextjs/server` has `subscribeToList`, which reads a form, sends it
with your secret key and forwards the visitor's address:

```ts
'use server';
import { subscribeToList } from '@rekey.dev/nextjs/server';

export async function join(formData: FormData) {
  await subscribeToList('waitlist', formData);
  return { ok: true };
}
```

The action is reachable by anyone who can load your page, so it is treated as
the browser it relays: the browser limits apply, it cannot add back someone
who left or rename a contact, and it always resolves `{ status: 'received' }`.
Tell the page only that the form was sent. It refuses to run without a visitor
address that is one IP address (`CLIENT_IP_MISSING`, also for an unreadable
`X-Forwarded-For`): set `REKEY_TRUSTED_PROXY_HOPS` to the number of proxies in
front of your app, or pass `{ clientIp }`. It also sends `X-Rekey-Relay:
browser`. From your own code, relay a form with
`rekey.with({ clientIp }).lists.subscribe(key, body, { relay: 'browser' })`.

Name the inputs `email`, `name`, `consent` (a checkbox), `consentVersion` (a
hidden input with the version from `rekey.lists.get`) and `hp` (a hidden
honeypot). Every other input goes into `fields`.

## Taking someone off a list

Rekey sends no email to a list, so your email tool owns the unsubscribe link.
Sync it back from your server:

```bash
curl -X DELETE "$REKEY_URL/api/v1/lists/waitlist/members/ada@example.com" \
  -H "Authorization: Bearer $REKEY_SECRET"
# → { "data": { "status": "unsubscribed" } }   or "not_subscribed"
```

It needs a secret key with `contacts:write` and works on archived lists. The
member is kept as `unsubscribed`, so a browser can never add them back.

## Retention and erasure

- `submissionRetentionDays` on a list deletes its submissions after that many
  days, on the API's regular prune sweep. Unset keeps them.
- Erasing an end user erases the contact at the same address in the same
  Application. A contact who never signed up is erased with
  `DELETE /api/v1/tenant/applications/:id/contacts/:contactId` (workspace
  OWNER only). Both scrub the address, name and submitted fields from stored
  webhook deliveries. See [data-erasure.md](data-erasure.md).
- The DSAR export of an end user includes the contacts at every address
  erasure covers (their current address and any pending email change) under
  `contacts`, with each list's consent proof (the exact text they agreed to)
  and their submissions.
- For 30 days after an erasure, a browser or relayed subscribe at the erased
  address stores nothing, so a stranger cannot put the person straight back.
  Rekey keeps a keyed hash of the address for that, never the address. Your
  own server speaking for itself can still add them.

## Webhooks

`contact.subscribed`, `contact.unsubscribed` and `contact.submission.created`,
written in the same transaction as the change. See
[webhooks.md](webhooks.md#lists).

## Agents

The operator MCP server has two read tools, `list_contact_lists` and
`get_contact_list_stats`, which return counts and never addresses. There is no
MCP tool to export or erase contacts.

## Errors

See "Lists and contacts" in [errors.md](errors.md).
