/**
 * OpenAPI / Swagger setup.
 *
 * Two consumers:
 *   1. **Humans** — open `/docs` in a browser to explore the API.
 *   2. **AI agents** — fetch `/docs/json` for a machine-readable schema.
 *
 * Keep `tags` consistent ("Admin · Tenants", "Admin · Applications", etc.) so
 * the docs UI groups routes intuitively. Every route should have at minimum
 * `summary` and ideally `description`.
 *
 * **Security schemes are a contract, not decoration.** There is deliberately NO
 * top-level `security` default: six different credentials guard this API and no
 * single one is a sane fallback, so a route with no `security` would silently
 * inherit a lie. Instead every route states its own `security` — including
 * `security: []` for genuinely public routes, so "public" is asserted rather
 * than inferred from an omission.
 *
 * Reading the array: the outer array is OR, each object's keys are AND. So
 * `[{ apiKey: [] }, { publishableKey: [] }]` means "secret key OR publishable
 * key", while `[{ apiKey: [], userToken: [] }]` means "secret key AND the
 * end-user JWT". OpenAPI cannot express role or grant requirements
 * (`requireTenantRole`, `ensureAppAccess`, API-key scopes) — those belong in the
 * route's `description`.
 */

import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerOpenApiComponents } from './openapi.js';

/**
 * The version the published document announces itself as.
 *
 * Derived, not hardcoded. It was a string literal until 2.0.0-rc.3 and had gone
 * three minor versions stale — the document served at `/docs/json` said `1.1.1`
 * while we were cutting 2.0.0, which every client generator, registry, and
 * integrator diffing against the previous release would have believed.
 *
 * `@rekey.dev/shared-types` is the right source: the CHANGELOG states the
 * packages share one version and release together with the API, panel, and
 * portal, so its `package.json` IS the release version. (`apps/api`'s own
 * package.json is `0.0.0` — it is private and never published.) `createRequire`
 * rather than an import attribute so this resolves identically from `src/` under
 * tsx and from `dist/` under node, without depending on the build layout.
 *
 * `test/openapi-contract.test.ts` asserts this matches both the package version
 * and the top CHANGELOG heading, so the three cannot drift apart again.
 */
const { version: RELEASE_VERSION } = createRequire(import.meta.url)(
  '@rekey.dev/shared-types/package.json',
) as { version: string };

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  // Shared response components (`components.schemas`) + the pass-through
  // serializer that keeps those schemas documentation rather than a filter.
  // Must run on the root instance before any route plugin registers — see
  // lib/openapi.ts for the full reasoning.
  registerOpenApiComponents(app);

  await app.register(swagger, {
    // Name `components.schemas` entries after the schema's own `$id`.
    // @fastify/swagger's default numbers them `def-0`, `def-1`, … which makes
    // every generated client type anonymous and reshuffles on every route
    // change — a diffable, stable document needs real names.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return typeof json.$id === 'string' ? json.$id : `def-${i}`;
      },
    },
    openapi: {
      info: {
        title: 'Rekey API',
        description:
          'Self-hostable authentication + billing + admin REST API. All money is in ' +
          'integer minor units (cents). Every error carries a `code`, human `message`, ' +
          'and a `fix`.\n\n' +
          '## Which credential do I send?\n\n' +
          'Six different credentials guard this API. Each route documents its own — ' +
          'read the padlock, not this list. In short:\n\n' +
          '- **Publishable key** (`rp_pub_…`, `Authorization: Bearer`) — the browser ' +
          'credential. Safe to ship in client-side JavaScript. Accepted on the ' +
          'public-bootstrap surface (sign-in/up, magic link, passkeys, OAuth start, ' +
          'plan/subscription reads, checkout, organizations). Restricted by the ' +
          "Application's origin allowlist rather than kept secret.\n" +
          '- **Application secret key** (`rp_live_…` / `rp_test_…`, `Authorization: ' +
          'Bearer`) — the server-side credential. Accepted everywhere the publishable ' +
          'key is, plus the privileged surface it cannot reach (usage, credits, ' +
          'licenses, coupon redemption, session/user administration). Never ship it to ' +
          'a browser.\n' +
          '- **End-user JWT** (`X-Rekey-User-Token`) — sent *in addition to* one of ' +
          'the two keys above on routes that act on behalf of a signed-in end user. ' +
          'You get it from the `token` in a sign-in response.\n' +
          '- **Operator session** (`Authorization: Bearer` access token) — for the ' +
          'panel/operator surface under `/api/v1/tenant/*`.\n' +
          '- **Operator PAT** (`rp_op_…`, `Authorization: Bearer`) — long-lived operator ' +
          'token for scripts and agents.\n' +
          '- **Super-admin key** (`SUPER_ADMIN_KEY`, `Authorization: Bearer`) — the ' +
          'self-host bootstrap credential, for `/api/v1/admin/*` only.\n\n' +
          'Provider webhook ingress routes take **no** credential at all — the ' +
          'provider signature is the authentication.',
        version: RELEASE_VERSION,
      },
      servers: [
        { url: 'https://api.rekey.dev', description: 'Production' },
        { url: 'http://localhost:3030', description: 'Local development' },
      ],
      components: {
        securitySchemes: {
          superAdminKey: {
            type: 'http',
            scheme: 'bearer',
            description:
              '**What:** the self-host bootstrap admin credential — a single shared ' +
              'secret, not tied to any workspace or Application.\n\n' +
              '**Where from:** the `SUPER_ADMIN_KEY` environment variable you set on the ' +
              'API deployment.\n\n' +
              '**Where used:** `/api/v1/admin/*` only. Server-side only — this key can ' +
              'read and write every tenant on the deployment, so treat it like a root ' +
              'password. `requireApiKey` and the operator guards all reject it.',
          },
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'rp_live_… / rp_test_…',
            description:
              '**What:** an Application-scoped **secret** key. Full server-side authority ' +
              'over that one Application. The `rp_test_` / `rp_live_` prefix follows the ' +
              "Application's `environment` and is descriptive only — nothing branches on " +
              'it. Isolation is the Application boundary.\n\n' +
              '**Where from:** Panel → Application → API Keys (shown once at mint time). ' +
              'Used by `@rekey.dev/node`.\n\n' +
              '**Where used:** every non-admin, non-operator route. Some keys are minted ' +
              'with narrow scopes (`auth:read`, `auth:write`, `billing:read`, ' +
              '`billing:write`, `webhooks:read`); when a route needs a specific scope its ' +
              'description says so. May also be restricted by the ' +
              "Application's IP allowlist.\n\n" +
              '**Never** put this in browser or mobile-client code — use the publishable ' +
              'key there.',
          },
          publishableKey: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'rp_pub_…',
            description:
              '**What:** the Application **publishable** key — a browser-safe credential. ' +
              'It identifies the Application and asserts "legitimate public client"; it ' +
              'grants nothing on its own (sign-in still needs the password or passkey, ' +
              'license verify still needs the license key).\n\n' +
              '**Safe in browser code.** It is designed to be embedded in client-side ' +
              'JavaScript, mobile apps, and public HTML. Its protection is the ' +
              "Application's **origin allowlist** (Panel → Application → Access) plus " +
              'per-route rate limits, not secrecy.\n\n' +
              '**Where from:** Panel → Application (displayed alongside the secret key). ' +
              'Rotating it leaves the previous key valid for a grace window so clients ' +
              'can redeploy.\n\n' +
              '**Where used:** only the public-bootstrap surface — routes guarded by ' +
              '`requirePublishableOrSecretKey`. A `requireApiKey` route rejects it with 401 ' +
              '`API_KEY_INVALID`; operator and admin routes use their own credentials and ' +
              'their own codes. API-key scopes do not apply to it — route membership ' +
              'is the gate. Where it does reach self-service billing or account ' +
              'management, the end-user\'s own token is required alongside it and is ' +
              'what authorizes the call; it never reaches administrative writes or ' +
              'another user\'s data.',
          },
          userToken: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Rekey-User-Token',
            description:
              '**What:** the end-user access JWT — proof that a specific end user of your ' +
              'Application is signed in. It is a *second* credential: send it **together ' +
              'with** the publishable or secret key in `Authorization`, never instead of ' +
              'one.\n\n' +
              '**Where from:** the `token` field returned by sign-in, sign-up, ' +
              'magic-link/OAuth/passkey completion, or `POST /api/v1/auth/refresh`.\n\n' +
              '**Where used:** every route that acts on behalf of the signed-in user — ' +
              '`/api/v1/users/me`, subscriptions and payment methods, organizations, MFA ' +
              'enrollment, coupon redemption. The JWT carries its issuing ' +
              '`applicationId` and must match the Application the key resolved to, so a ' +
              "token from one Application can't be replayed against another.",
          },
          tenantSession: {
            type: 'http',
            scheme: 'bearer',
            description:
              '**What:** an **operator** (workspace-member) session access token — the ' +
              'credential the Rekey panel uses. Scoped to one workspace plus the ' +
              "operator's live role in it (OWNER / ADMIN / MEMBER).\n\n" +
              '**Where from:** `POST /api/v1/tenant/auth/sign-in` (or the passkey / OAuth ' +
              'equivalents) returns `accessToken`; refresh it at ' +
              '`POST /api/v1/tenant/auth/refresh`. Short-lived — for scripts and agents ' +
              'prefer an operator PAT.\n\n' +
              '**Where used:** the operator surface under `/api/v1/tenant/*`. Workspace ' +
              'membership and role are re-read from the database on every request, so a ' +
              'downgrade or removal takes effect immediately. Routes that additionally ' +
              'demand OWNER/ADMIN, or a per-Application grant, say so in their ' +
              'description — OpenAPI cannot express that here.',
          },
          operatorPat: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'rp_op_…',
            description:
              '**What:** an operator **personal access token** — a long-lived stand-in ' +
              'for an operator session, for scripts, CI, and AI agents. Bound to one ' +
              'operator and one workspace, and carries its own scope list ' +
              '(`read`, `keys:mint`, `mcp:operator:write`, …) that is default-deny.\n\n' +
              '**Where from:** `POST /api/v1/tenant/auth/api-tokens` (requires an ' +
              'operator session). Shown once at mint time.\n\n' +
              '**Where used:** `/api/v1/tenant/operator/*` and the operator MCP endpoint. ' +
              "Workspace membership and the operator's live role are re-checked on every " +
              'request, so revoking membership kills the token. Server-side only.',
          },
          mcpAccessToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              '**What:** the credential for the operator MCP JSON-RPC endpoint ' +
              '(`/api/v1/tenant/mcp`). The guard accepts **either** an operator PAT ' +
              '(`rp_op_…`, which must carry the `read` scope) **or** an OAuth-issued ' +
              "access JWT (`typ: op_mcp_access`) minted by this deployment's operator-MCP " +
              'authorization server. One bearer at a time — credentials are not chained.\n\n' +
              '**Where from:** mint a PAT at `POST /api/v1/tenant/auth/api-tokens`, or let ' +
              'your MCP client run the OAuth flow starting at ' +
              '`GET /api/v1/tenant/mcp/oauth/authorize`.\n\n' +
              '**Where used:** the MCP endpoint only. Read tools need nothing beyond ' +
              'authentication; write tools additionally require the ' +
              '`mcp:operator:write` scope (plus `applications:write` on the OAuth path) ' +
              'and an OWNER/ADMIN role floor.',
          },
          endUserMcpToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              "**What:** an **end-user** MCP access JWT (`typ: mcp_access`), scoped to one " +
              'Application and one of its end users. Distinct from `mcpAccessToken`, which is ' +
              'the operator-facing MCP credential — do not mix them up.\n\n' +
              '**Where from:** the OAuth 2.1 + PKCE flow this deployment hosts per Application ' +
              'at `/api/v1/mcp/{slug}/oauth/authorize` → `/oauth/token`. An MCP client ' +
              '(e.g. a custom connector) drives it; the end user signs in and consents.\n\n' +
              '**Where used:** `POST /api/v1/mcp/{slug}` only. Read-only — it exposes that ' +
              "user's own profile, subscription, and usage. Invalidated by the Application's " +
              'session kill-switch (`tokenGeneration`) like any other end-user token.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
