/**
 * The OpenAPI contract test.
 *
 * ## Why this exists
 *
 * Before 2.0.0-rc.3 the published document declared response schemas for
 * exactly **one** of 276 operations. Everything else was
 * `"200": {"description": "Default Response"}`. Two external audits called that
 * "half a contract": you could not generate a typed client, the
 * `{success, data}` envelope was undocumented, and no error shape appeared
 * anywhere.
 *
 * Response schemas are documentation, not serialisation (see lib/openapi.ts for
 * why), so **nothing at runtime notices when one goes missing**. This test is
 * the only thing standing between the fixed document and a slow slide back. It
 * is what makes the 2.0.0 surface freeze mean something.
 *
 * ## What it enforces
 *
 * 1. The document parses as valid OpenAPI 3.0 — via a real validator
 *    (`@apidevtools/swagger-parser`), not our own reading of the spec.
 * 2. Every operation declares at least one 2xx response carrying a content
 *    schema. The list of operations allowed to lack one is `UNCOVERED`, which
 *    must only ever shrink.
 * 3. Every operation declares at least one non-2xx response. An endpoint that
 *    cannot fail does not exist.
 * 4. No list operation declares a bare array as its `data`. A bare array
 *    cannot report `total`, so a caller cannot tell a full page from a
 *    silently truncated one — the defect the functional audit found on 17
 *    operations. `{items, page}` (helper: `okPage`) is the shape.
 * 5. `components.schemas` is non-empty and every `$ref` resolves.
 *
 * ## When this fails on your PR
 *
 * You added a route without a `response` block. Add one — `apps/api/src/lib/
 * openapi.ts` documents the helpers, and
 * `apps/api/src/modules/applications/applications.routes.ts` is the worked
 * example. Do not add your route to `UNCOVERED`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

interface Operation {
  id: string;
  method: string;
  path: string;
  tag: string;
  op: Record<string, any>;
}

/**
 * Operations that legitimately declare no 2xx response body schema.
 *
 * **This list may only shrink.** Adding to it is how the document rots back to
 * where it started; if your new route cannot be modelled, that is a signal
 * about the route, not about this test.
 */
const UNCOVERED: ReadonlySet<string> = new Set<string>([
  // (empty — every operation declares a response schema)
]);

/**
 * Operations whose success response is deliberately not a JSON body: OAuth
 * authorize redirects and the like. They still declare responses; they just
 * have no 2xx *content* schema to check.
 */
const NON_JSON_SUCCESS: ReadonlySet<string> = new Set<string>([
  // These three have no 2xx because they have no 2xx code path — not because
  // nobody got round to modelling one. Each was read to confirm it.
  //
  // The two MCP GETs answer `reply.code(405)` unconditionally: the surface is
  // JSON-RPC over POST, and the GET exists only so a curl-typer sees an
  // explicit method violation instead of a 404.
  'GET /api/v1/mcp/{slug}',
  'GET /api/v1/tenant/mcp',
  // The OAuth authorize endpoint either 302s to the panel consent screen or
  // renders an HTML error page. It declares its 302, 400 and 503; there is no
  // JSON success to describe.
  'GET /api/v1/tenant/mcp/oauth/authorize',
]);

/**
 * The one operation allowed to declare no failure mode.
 *
 * `GET /health/live` is the only route in the API carrying
 * `config: { rateLimit: false }`. It touches no dependency, reads no input,
 * and takes no credential, so it cannot 429, 4xx or 503 — it is the liveness
 * probe, and a liveness probe that can fail for reasons other than the process
 * being dead is not one. Declaring a decorative 429 here to satisfy the check
 * below would be a lie that costs a container restart during an incident.
 */
const NO_ERROR_RESPONSE: ReadonlySet<string> = new Set<string>([
  'GET /health/live',
]);

/**
 * Error responses that deliberately are not the `{success, error}` envelope,
 * because their consumer is not an SDK.
 *
 * The health probes answer a container orchestrator, which reads a status code
 * and at most a flat body naming the failed dependency. The provider webhook
 * receivers answer Stripe, PayPal and Razorpay, whose retry logic reads the
 * status code — wrapping those in our envelope would change a contract three
 * external systems already depend on, to no one's benefit.
 */
const NON_ENVELOPE_ERRORS: ReadonlySet<string> = new Set<string>([
  'GET /health → 503',
  'GET /health/ready → 503',
  'POST /api/v1/billing/webhook/stripe/{slug} → 500',
  'POST /api/v1/billing/webhook/paypal/{slug} → 500',
  'POST /api/v1/billing/webhook/razorpay/{slug} → 500',
  'POST /api/v1/webhooks/billing/{provider} → 500',
  'POST /api/v1/webhooks/billing/{provider}/{slug} → 500',
]);

/**
 * Collections bounded by construction — a fixed registry, a one-shot mint, an
 * Application's own configured providers. These cannot grow with tenant usage,
 * so there is nothing to truncate and no `total` worth reporting.
 *
 * Anything backed by a table that grows does NOT belong here: use `okPage`.
 */
const ALLOWED_BARE_ARRAYS: ReadonlySet<string> = new Set<string>([
  // One row per OAuth provider the end-user has actually linked — at most the
  // number of providers the Application configures.
  'GET /api/v1/auth/oauth/identities → 200',
  // Active keys per Application are capped at MAX_KEYS_PER_APP (25) at mint
  // time, so this list has a hard ceiling enforced on the write path.
  'GET /api/v1/tenant/applications/{id}/api-keys → 200',
  'GET /api/v1/admin/applications/{id}/api-keys → 200',
  // A plan's entitlement bundle. Authored by the operator per plan, and a plan
  // with enough entitlements to need paging is a modelling problem.
  'GET /api/v1/tenant/applications/{id}/plans/{slug}/entitlements → 200',
  // One row per supported payment provider (three), configured or not.
  'GET /api/v1/tenant/applications/{id}/billing-credentials → 200',
  // Roles are authored per Application, not accumulated by usage. Three
  // catalogs, same reasoning: an operator curates each by hand, so none is
  // backed by a table that grows with traffic. (The former
  // `/end-user-roles` path is still served but hidden from the spec, so it
  // needs no entry here.)
  'GET /api/v1/tenant/applications/{id}/application-roles → 200',
  'GET /api/v1/tenant/applications/{id}/organization-roles → 200',
  // The same organization-role catalog, read by an end-user so an org-admin UI
  // can populate its role picker. Bounded by the operator-authored catalog it
  // reflects, not by how many organizations or members exist.
  'GET /api/v1/users/me/organizations/roles → 200',
  // A fixed registry of transactional email events, same length for everyone.
  'GET /api/v1/tenant/applications/{id}/email-templates → 200',
  // Two fixed top-20 slices (`.slice(0, 20)` in the handlers), never paginated.
  'GET /api/v1/admin/metrics/webhook-endpoint-health → 200',
  'GET /api/v1/admin/metrics/payments-by-app → 200',
]);

function collect(spec: Record<string, any>): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, any>)[method];
      if (!op) continue;
      out.push({
        id: `${method.toUpperCase()} ${path}`,
        method,
        path,
        tag: op.tags?.[0] ?? '(untagged)',
        op,
      });
    }
  }
  return out;
}

/** Does this response object carry a schema for some content type? */
function hasContentSchema(response: Record<string, any> | undefined): boolean {
  if (!response?.content) return false;
  return Object.values(response.content).some(
    (media) => (media as Record<string, unknown>)?.schema !== undefined,
  );
}

function successResponses(op: Record<string, any>): Array<[string, Record<string, any>]> {
  return Object.entries(op.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status)) as Array<
    [string, Record<string, any>]
  >;
}

function errorResponses(op: Record<string, any>): string[] {
  return Object.keys(op.responses ?? {}).filter((status) => /^[45]\d\d$/.test(status));
}

/**
 * The `data` schema of a `{success, data}` envelope, resolved one level through
 * `$ref` into `components.schemas`.
 */
function envelopeData(
  schema: Record<string, any> | undefined,
  spec: Record<string, any>,
): Record<string, any> | undefined {
  const resolved = deref(schema, spec);
  return deref(resolved?.properties?.data, spec);
}

function deref(
  schema: Record<string, any> | undefined,
  spec: Record<string, any>,
): Record<string, any> | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.replace('#/components/schemas/', '');
  return spec.components?.schemas?.[name];
}

describe('published OpenAPI document', () => {
  let app: FastifyInstance;
  let spec: Record<string, any>;
  let operations: Operation[];

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    spec = app.swagger() as Record<string, any>;
    operations = collect(spec);
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses and validates as OpenAPI', async () => {
    // `validate` runs the structural metaschema AND resolves every $ref.
    // It mutates its input, so hand it a deep copy — later assertions read the
    // un-dereferenced document on purpose (they check that refs point at
    // components, which dereferencing would erase).
    await expect(
      SwaggerParser.validate(JSON.parse(JSON.stringify(spec))),
    ).resolves.toBeDefined();
  });

  it('announces the version we are actually shipping', () => {
    // This was hardcoded `1.1.1` while 2.0.0 was being cut — three minor
    // versions stale, on the artefact integrators diff between releases. It is
    // now derived from @rekey.dev/shared-types (the version the packages, API,
    // panel and portal all share), and pinned here against the CHANGELOG so a
    // release cannot bump one without the others.
    const require_ = createRequire(import.meta.url);
    const { version } = require_('@rekey.dev/shared-types/package.json') as { version: string };

    expect(spec.info.version).toBe(version);
    expect(spec.info.version).not.toMatch(/^[01]\./);

    const changelog = readFileSync(
      new URL('../../../CHANGELOG.md', import.meta.url),
      'utf8',
    );
    const latestHeading = /^## (.+)$/m.exec(changelog)?.[1]?.trim();
    expect(
      latestHeading,
      `the top CHANGELOG heading is "${latestHeading}" but the document announces "${version}" — ` +
        'bump both, or the published contract lies about which release it describes',
    ).toBe(version);
  });

  it('defines shared components rather than inlining the envelope 276 times', () => {
    const names = Object.keys(spec.components?.schemas ?? {});
    expect(names.length).toBeGreaterThan(0);
    // The envelope and its parts must be components — that is the entire point
    // of "define it once".
    expect(names).toEqual(expect.arrayContaining(['ErrorResponse', 'RekeyError', 'PageMeta']));
    // Auto-generated placeholder names mean the refResolver regressed; every
    // generated client type would be called `Def0`.
    expect(names.filter((n) => /^def-\d+$/.test(n))).toEqual([]);
  });

  it('every operation declares a 2xx response with a content schema', () => {
    const missing = operations
      .filter((o) => !UNCOVERED.has(o.id) && !NON_JSON_SUCCESS.has(o.id))
      .filter((o) => !successResponses(o.op).some(([, r]) => hasContentSchema(r)))
      .map((o) => `${o.id}  [${o.tag}]`);

    expect(missing, `operations with no 2xx response schema:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every operation declares at least one error response', () => {
    const missing = operations
      .filter((o) => !UNCOVERED.has(o.id) && !NO_ERROR_RESPONSE.has(o.id))
      .filter((o) => errorResponses(o.op).length === 0)
      .map((o) => `${o.id}  [${o.tag}]`);

    expect(missing, `operations declaring no failure mode:\n${missing.join('\n')}`).toEqual([]);
  });

  it('declares no error response without the shared error envelope', () => {
    const wrong: string[] = [];
    for (const o of operations) {
      for (const status of errorResponses(o.op)) {
        const response = o.op.responses[status];
        if (!hasContentSchema(response)) continue;
        const schema = response.content['application/json']?.schema;
        if (!schema) continue;
        // Either the shared envelope, or a documented RFC-shaped body (the
        // OAuth 2.1 endpoints return `{error, error_description}` per RFC 6749,
        // which is correct for them and must NOT be forced into ours).
        const isRekeyEnvelope = schema.$ref === '#/components/schemas/ErrorResponse';
        const isRfcOAuthError = schema.properties?.error !== undefined;
        if (!isRekeyEnvelope && !isRfcOAuthError && !NON_ENVELOPE_ERRORS.has(`${o.id} → ${status}`)) {
          wrong.push(`${o.id} → ${status}`);
        }
      }
    }
    expect(wrong, `error responses using an unrecognised shape:\n${wrong.join('\n')}`).toEqual([]);
  });

  it('never declares a bare array as a list response', () => {
    // A bare `data: [...]` cannot carry `total`, so a caller has no way to
    // learn the response was truncated. `okPage()` exists for this.
    const bare: string[] = [];
    for (const o of operations) {
      for (const [status, response] of successResponses(o.op)) {
        if (!hasContentSchema(response)) continue;
        const data = envelopeData(response.content['application/json']?.schema, spec);
        if (data?.type !== 'array') continue;
        // Bounded-by-construction collections are allowed — they cannot
        // truncate because they are not backed by a growing table.
        bare.push(`${o.id} → ${status}`);
      }
    }
    const offending = bare.filter((entry) => !ALLOWED_BARE_ARRAYS.has(entry));
    expect(
      offending,
      // Report only what actually failed. Printing the whole `bare` set buried
      // the one real offender under seven allowed entries.
      `list responses declared as a bare array (use okPage):\n${offending.join('\n')}`,
    ).toEqual([]);

    // The allow-list may only shrink, and it shrinks by an operation moving to
    // `okPage` — at which point its entry here is dead weight that would later
    // be read as permission for a *different* route to go bare. Every entry
    // must still name a live bare-array operation.
    const stale = [...ALLOWED_BARE_ARRAYS].filter((entry) => !bare.includes(entry));
    expect(
      stale,
      `ALLOWED_BARE_ARRAYS entries that no longer name a bare-array operation ` +
        `(delete them):\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('declares no closed component — these describe a floor, not a ceiling', () => {
    // `lib/openapi.ts` states the rule in its header ("No component sets
    // `additionalProperties: false` … a response may carry more") and its
    // `fromZod` comment claims to delete the flag. It deleted `$schema` only,
    // so 40 of the 55 components shipped closed and the audit found responses
    // that could not validate against their own declaration:
    //
    //   - `GET /users/me` and `GET /auth/me` were `allOf: [EndUser(closed),
    //     {required: [activeOrganizationId]}]` — unsatisfiable by construction.
    //   - `GET /tenant/applications/:id` returned 15 fields `Application` does
    //     not declare.
    //
    // `additionalProperties: true` is a different statement (a `metadata` bag
    // taking any keys) and is left alone; only `false` is a violation.
    const closed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'additionalProperties' && value === false) closed.push(path);
        else walk(value, `${path}.${key}`);
      }
    };
    for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
      walk(schema, name);
    }
    expect(
      closed,
      `components declaring additionalProperties: false:\n${closed.join('\n')}`,
    ).toEqual([]);
  });

  it('covers the whole surface', () => {
    // A blunt floor so a refactor that deletes half the routes — or half the
    // schemas — is loud rather than quietly green.
    expect(operations.length).toBeGreaterThanOrEqual(276);

    // Measured over the operations that CAN have a JSON success body. The
    // three in NON_JSON_SUCCESS have no 2xx code path at all — two answer 405
    // unconditionally, one only ever redirects — so counting them as
    // "uncovered" measures the router's shape rather than the document's
    // completeness, and pinned the ratio just under any threshold worth
    // setting. Excluded from the denominator, not waved through: they are
    // named individually up top, and the set is asserted below so it cannot
    // quietly grow.
    const describable = operations.filter((o) => !NON_JSON_SUCCESS.has(o.id));
    const covered = describable.filter((o) =>
      successResponses(o.op).some(([, r]) => hasContentSchema(r)),
    );
    expect(covered.length).toBe(describable.length);

    // The exemption list is part of the contract. If it grows, that is a
    // decision someone has to make deliberately rather than discover.
    expect(NON_JSON_SUCCESS.size).toBe(3);
  });
});
