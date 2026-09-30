# Profile fields

Onboarding answers you want kept on each end user: company, role, team size,
how they heard about you. You define the questions once per Application;
Rekey validates every answer against them and stores it on the user's
`profile`.

`profile` is separate from `metadata`. Rekey never interprets `metadata`;
`profile` is typed, validated and shown on the end user's Overview in the panel, where an operator can also edit the answers.

## Defining the fields

In the panel: **Users → Onboarding** (the old Profile fields address redirects there). Over the API:

```http
PUT /api/v1/tenant/applications/:id/profile-schema
{ "fields": [
  { "key": "company",   "label": "Company",   "type": "text",   "requiredForOnboarding": true },
  { "key": "team_size", "label": "Team size", "type": "select", "options": ["1", "2-10", "11+"], "requiredForOnboarding": true },
  { "key": "plan_tier", "label": "Plan tier", "type": "text",   "writableBy": "server" }
] }
```

Each field:

| Property | Meaning |
|---|---|
| `key` | Where answers are stored. 1-40 lowercase letters, digits or `_`, starting with a letter. `constructor` and `prototype` are reserved. |
| `label` | The question. Change it whenever you like. |
| `type` | `text` (up to 500 characters), `select` (one of `options`), `number`, `boolean`, `url` (http or https) or `date` (`YYYY-MM-DD`). |
| `options` | The answers a `select` allows. Required for `select`, refused for other types. |
| `requiredForOnboarding` | Must be answered before `onboarding/complete` succeeds. It governs that route only: sign-in and skipping are never blocked on it. Default `false`. |
| `writableBy` | `user` (default): the signed-in user may answer it. `server`: only a secret key or an operator may, for values you set yourself (a plan tier, a CRM id). |
| `showInList` | Show it as a column in the panel's end-user list (the first three such fields). Default `false`. |
| `pii` | Marks personal data. Recorded now and not yet enforced: today anyone with `end-users:read` sees every answer. |

At most 50 fields. The PUT replaces the whole list, in one transaction that
also holds off new answers while it checks them:

- A field that any user has answered keeps its key and type: removing or
  retyping it answers `409 PROFILE_FIELD_KEY_IMMUTABLE`. To reword a question,
  change its label.
- A select option that users picked cannot be removed:
  `409 PROFILE_OPTION_IN_USE`, with the count per option. Change those
  answers first, or keep the option. Adding options is always fine.
- `GET` returns `version` beside `fields`. Send it back with the PUT and a
  write made after someone else's is refused with `409 PROFILE_SCHEMA_CHANGED`
  instead of silently undoing it. The panel always sends it.

## Writing answers

| Who | Route | Can set |
|---|---|---|
| The signed-in user (publishable key + user token) | `PATCH /api/v1/users/me/profile` | `writableBy: "user"` fields |
| Your server (secret key, `auth:write`) | `PATCH /api/v1/users/:id/profile`, `rekey.users.updateProfile(id, patch)` | every field |
| An operator | `PATCH /api/v1/tenant/applications/:id/end-users/:euid/profile` | every field |

The body is the answers to set, keyed by field key. `null` clears an answer
and keys you omit are kept. Every write is checked against the schema before
anything is stored: an unknown key is `PROFILE_FIELD_UNKNOWN`, a user writing a
server field is `PROFILE_FIELD_READ_ONLY`, a value of the wrong shape is
`PROFILE_FIELD_INVALID`, and more than 16 KB of answers is
`PROFILE_TOO_LARGE`. Concurrent writes of different fields keep every answer.

A write that changes an answer emits `user.updated` with
`changed: ["profile.company", ...]`, field names only, never values, and `via`
`self`, `server` or `operator`.

Reading: `GET /api/v1/users/me`, `GET /api/v1/auth/me` and
`GET /api/v1/users/:id` return `profile`, `onboardingCompletedAt`,
`onboardingSkippedAt` and `onboardingStatus`. `GET /api/v1/profile-schema` returns the fields to
render: with a publishable key only the ones the user may answer, with a
secret key all of them.

```ts
// Your backend
await rekey.users.updateProfile(userId, { plan_tier: 'enterprise' });
```

## Onboarding

Rekey records onboarding. It never enforces it. Sign-in, refresh and every
other route work the same for a user who has not finished, and nothing in Rekey
redirects or blocks them. Whether a user must finish before using your app, or
may skip and come back later, is your app's decision. Rekey keeps the record so
your app, your server and the panel all see the same answer.

Each user has an `onboardingStatus`:

| Status | Meaning |
|---|---|
| `pending` | Neither completed nor skipped. Every user starts here. |
| `skipped` | The user chose to skip. `onboardingSkippedAt` says when. |
| `completed` | Onboarding was completed, whether or not it was skipped first. `onboardingCompletedAt` says when. |

It is derived from the two timestamps, so it is never stored out of step with
them. The `onboardingStatus(user)` helper in `@rekey.dev/shared-types` derives
it the same way.

### Completing

`POST /api/v1/users/me/onboarding/complete` (or `/api/v1/users/:id/onboarding/complete`
with a secret key, or `.../end-users/:euid/onboarding/complete` for an
operator) marks onboarding done once every `requiredForOnboarding` field has an
answer. Otherwise it answers `409 PROFILE_INCOMPLETE` with the unanswered keys
in `details.missing`. "Complete" means "answered", which is why this check
stays. `requiredForOnboarding` governs this route and nothing else: it does not
block sign-in, profile writes, skipping, or any other call.

The first success stamps `onboardingCompletedAt` and emits
`user.onboarding_completed` (`data.userId`, `completedAt`, `via`). Later calls
return the same time and emit nothing, however many race. A user who skipped
can still complete; `onboardingSkippedAt` is kept as history.

### Skipping

`POST /api/v1/users/me/onboarding/skip` (publishable key plus the user token),
`POST /api/v1/users/:id/onboarding/skip` (secret key, `auth:write`) or
`POST /api/v1/tenant/applications/:id/end-users/:euid/onboarding/skip`
(operator, `end-users:write`) records that the user skipped. It takes no body
and checks no answers.

The first skip stamps `onboardingSkippedAt` and emits
`user.onboarding_skipped` (`data.userId`, `skippedAt`, `via`). Later skips
return the same time and emit nothing, however many race. A skip after
completion changes nothing: the status stays `completed` and no event is sent.

Every one of these routes returns the same shape:

```json
{
  "profile": { "company": "Acme" },
  "onboardingCompletedAt": null,
  "onboardingSkippedAt": "2026-09-30T10:00:00.000Z",
  "onboardingStatus": "skipped"
}
```

```ts
// Browser (@rekey.dev/react)
await client.skipOnboarding(accessToken);

// Your backend (@rekey.dev/node)
await rekey.users.skipOnboarding(userId);
await rekey.users.completeOnboarding(userId);
```

## Privacy

The DSAR export includes `profile`, `onboardingCompletedAt` and
`onboardingSkippedAt`. Erasure empties `profile` and clears
`onboardingSkippedAt` (see [data-erasure.md](data-erasure.md)).
