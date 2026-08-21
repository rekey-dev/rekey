# Organization roles

The roles a member can hold **inside one organization**. Not to be confused with
the application role (`EndUser.role`), which is one value per end-user across
your whole Application; see
[auth.md → Roles](auth.md#roles-two-axes-and-which-one-you-want) for the
distinction, which is the single most common mistake in this area.

## Names and tiers

A role is a free-form `name` plus a `baseRole` tier of `OWNER`, `ADMIN` or
`MEMBER`:

```json
{ "name": "content-manager", "baseRole": "MEMBER", "description": "Drafts and edits content" }
```

**Rekey gates on the tier and never on the name.** A `content-manager` on tier
MEMBER can do exactly what MEMBER can. The member-management ladder, the
last-owner guard and organization-scoped billing writes all read the tier. What
the name means beyond that is your application's business.

Three built-ins are seeded on every Application and cannot be renamed, re-tiered
or deleted: `OWNER`, `ADMIN`, `MEMBER`. They are what keeps memberships created
before you had a catalog resolving to the authority they always had.

## Who does what

| Act | Credential | Where |
|---|---|---|
| Define a role | operator, tenant session | Panel → Application → Users → Roles, `POST /tenant/applications/:id/organization-roles`, or the `create_organization_role` MCP tool |
| Assign a role | an org OWNER/ADMIN, **their own end-user token** | `PATCH /users/me/organizations/:id/members/:euid` |
| Read the catalog | any signed-in end-user | `GET /users/me/organizations/roles` |

End-users can read the catalog but never write it, so no organization member can
invent a name that outranks their own. Assignment needs no operator.

## Revoking a role

Set `disabled: true` on the role:

```
PATCH /api/v1/tenant/applications/:id/organization-roles/:name
{ "disabled": true }
```

Everyone holding it is refused immediately (403 `ORGANIZATION_ROLE_DISABLED`) on
every organization-scoped request, the role cannot be newly assigned, and an
invitation naming it cannot be redeemed. Memberships are **kept**, so setting
`disabled: false` restores everyone rather than requiring re-invitations.

Use this rather than the alternatives:

- **Re-tiering down** leaves holders with less authority and tells nobody. The
  refusal is silent, which is how a deliberate revocation gets mistaken for a
  bug in your app.
- **Deleting** needs somewhere to move everyone first, and is not reversible.

An OWNER-tier role cannot be disabled while it is some organization's only route
to an owner (409 `ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS`). That organization
would have nobody able to manage members or authorize a charge, and no way to
fix it from the inside. The same guard covers re-tiering and bulk reassignment,
because all three are the same stranding through different doors.

A disabled role also stops counting toward the last-owner guard, since a holder
who cannot act is not an owner in any useful sense.

## Caching, and what to set when you scale

Resolving a role name to its tier happens on nearly every organization-scoped
request, against a table with a handful of operator-authored rows. Each API
process caches an Application's catalog for `ORG_ROLE_CACHE_TTL_MS`
(default `5000`).

Staleness matters here, because this is authorization input: lower a tier, or
disable a role, and a process holding the old snapshot keeps granting the old
authority until it lets go. Three things bound that:

1. The process that made the change drops its own snapshot before returning.
2. It publishes the change on Redis, and every other process drops the same key
   on receipt. **This is the normal propagation path**, and it is why running
   several API replicas does not weaken the guarantee.
3. The TTL is the backstop for when Redis is unreachable at the moment of a
   change.

| Deployment | Suggested value |
|---|---|
| Single API process | `5000` (the default) is fine |
| Several replicas, Redis healthy | `5000`; invalidation arrives over Redis, the TTL rarely comes into play |
| Several replicas, and you want a hard ceiling on staleness regardless of Redis | `1000` |
| You would rather not think about it | `0` disables the cache and reads the catalog every time |

`0` is a legitimate choice. The read is a single indexed lookup of a few rows
and it is what the API did before the cache existed.

Membership rows are never cached. Changing which role a *person* holds takes
effect immediately; only changing what a role *name* means is subject to any of
the above.

## Errors

Every refusal in this area, with its code, is listed in
[errors.md → Organization roles](errors.md#organization-roles-the-org-scoped-catalog).
