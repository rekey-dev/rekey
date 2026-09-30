Three pre-stable regression findings. CLI and auth-adjacent, so please review before merge. Auto-merge is off.

## 1. `rekey init --owner-email` left the tenant unreachable (major)

`init` created the tenant, app and key through the super-admin routes, and those routes write no `TenantMembership`. `--owner-email` was only a label. When that person signed up in the panel, they got a second, empty workspace, and nobody could reach the one `init` had made.

**Fix:** a super-admin operator invite can now be bound to an existing workspace.

- `POST /api/v1/admin/operator-invites` accepts `tenantId`, `email` and `role` (default `OWNER`). A bound key expires after 7 days unless `expiresAt` is given. It stays single-use and hash-only, and only the super-admin can mint one. The response adds `inviteUrl` (`PANEL_URL/accept-invite?token=…`, or null).
- Redemption by a **new operator**: sign-up with the key as `inviteKey`, by password or OAuth first login. The operator joins the bound workspace at its role and no new workspace is created. This works in `open` and `invite` mode. `closed` still refuses. `workspaceName` is optional only in this case.
- Redemption by an **existing operator**: `GET /tenant/invitations/preview` and `POST /tenant/invitations/accept` dispatch on the `rp_opinv_` prefix and answer with the same shapes and codes, so the panel's accept-invite page handles both link kinds.
- The signed-in or signing-up email must equal the bound email. A mismatch returns `OPERATOR_INVITE_EMAIL_MISMATCH` at sign-up or `INVITATION_EMAIL_MISMATCH` at accept. Nothing is created and the key stays usable.
- `init` mints the invite right after the tenant, before the app and key, so a failure cannot cost the one-time API key. It prints the link, its expiry and the next step. `--json` gains `ownerInvite: { email, role, expiresAt, token, url }`.
- Panel: accept-invite sends a new account for an `rp_opinv_` link to `/sign-up?invite=…`, which hides the workspace-name and key fields and joins instead. It also adds the missing copy for `INVITATION_EMAIL_MISMATCH`.
- Plain sign-up and unbound invite keys behave as before in every mode.

**Review point, security:** the brief asked for the invite email to match the redeemer's *verified* email. OAuth only reaches this path with a provider-verified email. Password operators have no email-verification step in Rekey at all, because `emailVerified` is only ever set by OAuth or the ID-token assertion. So for them the match is on the account email. That is the same bar workspace invitations use today. Requiring the verified flag would make the invite unusable for every password operator. The link is still the primary credential: single-use, hashed, and expiring. This is logged in decisions.md as an open question.

## 2. Unknown API key scopes were accepted (minor)

`POST /tenant/applications/:id/api-keys` with `"not:a:real:scope"` returned 201, and the scope never matched anything. `apiKeysService.create` now refuses any scope outside `API_KEY_SCOPES` (`*`, the standard scopes, `credits:grant`, `email:send`) with `400 API_KEY_SCOPE_UNKNOWN`. The `fix` lists the valid scopes and `details.unknown` lists the rejected ones. Because the check is in the service, it covers the super-admin, tenant, operator-PAT and MCP `mint_api_key` paths. The CLI mints no scoped keys. The check runs on create only, so stored keys are untouched. The panel already sends only known scopes.

## 3. Preview `variables` skipped URL validation (minor)

The custom-template preview rendered `trackingUrl: "javascript:alert(1)"` as-is. The override is part of the documented OpenAPI contract. The panel sends `{}`, and no SDK uses it. So I kept the override and validated it with the send rules minus `required`: `400 EMAIL_VARIABLES_INVALID`.

## Tests

Each test failed on origin/main before the fix. Each guard was then mutation-checked by removing it and confirming its test fails:

- `test/workspace-bound-operator-invite.test.ts` (18): mint validation, super-admin only, hash-only storage, 7-day default, join at sign-up in open and invite mode, role, email mismatch, single use, expired, closed, OAuth, plain and unbound sign-up unchanged, existing-operator preview and accept, mismatch, expired and revoked, unbound key, and 8 concurrent accepts that consume once. Mutants killed: sign-up email check, OAuth email check, accept email check, the single-use `usedAt` guard, the open-mode lookup, accept expiry, the default TTL. One survivor: the `isBound` check in preview is redundant with the `tenant === null` check that follows it.
- `test/api-key-scope-validation.test.ts` (5): all four mint paths, plus every valid scope and the default still mint.
- `test/custom-email-templates.test.ts`: new preview-override case.
- `packages/cli/test/cli.test.ts`: `init` request order and body, text output and `--json` output, with and without `PANEL_URL`.
- Neighbours run green: signup-mode, operator-signup-mode, tenant-auth, tenant-oauth, invitation-accept-race, operator-oidc-assertion, admin, openapi-contract, error-contract*, uncovered-error-codes, route-access-completeness, cross-tenant-matrix, elevated-scope-mint, operator-pat, operator-mcp-write and others (28 files, 448 tests). Panel suite green. `pnpm typecheck` green.

## What an operator will notice

- `rekey init` prints an owner invite link. Sending it to `--owner-email` is how that person gets into the workspace.
- Sign-up with a workspace-bound key joins that workspace. `workspaceName` is no longer required in that case, and a missing name otherwise returns `WORKSPACE_NAME_REQUIRED` instead of `BAD_REQUEST`.
- Minting a key with an unknown scope now fails with 400.
- A preview with bad `variables` now fails with 400.

Migration: `20260928095906_operator_invite_workspace_binding` adds three nullable columns plus an FK and an index on `operator_invites`. It is additive.
