/**
 * An Application's auth configuration is declared FOUR separate times, and the
 * four have to agree about which fields exist.
 *
 *   1. `AuthConfigSchema` (packages/shared-types): what can be STORED. A key
 *      it does not declare is dropped on parse.
 *   2. `AUTH_CONFIG_PATCH_BODY`: what the operator REST route ACCEPTS. It is
 *      `.strict()`, so a key missing here is refused however well it is
 *      declared on the schema.
 *   3. `AUTH_CONFIG_PATCH_BODY_JSON_SCHEMA`: what `openapi.json` DOCUMENTS. No
 *      `additionalProperties: false`, so a key missing here still works and is
 *      merely invisible to everyone generating a client.
 *   4. The `update_auth_config` operator MCP tool: what an agent can set. Its
 *      `additionalProperties: false` is ADVISORY, not enforced — the schema is
 *      only advertised in `tools/list` and `tenant-mcp-server.ts` never
 *      validates arguments against it. So a key missing here is not refused,
 *      it is dropped by the handler, and the caller is told the write
 *      succeeded. That is the worst of the four failure modes.
 *
 * They had drifted three different ways, and every one was silent until a
 * caller hit it:
 *
 *   - `hostedAuthorizeUrl` was on the schema and on the panel but not in (2).
 *     The panel's save button answered "Unrecognized key(s) in object:
 *     'hostedAuthorizeUrl'" and the feature was unreachable in production while
 *     every layer around it worked.
 *   - It was missing from (3) as well, so once that was fixed the field worked
 *     and still did not appear in the published spec.
 *   - The MCP tool could not set it at all, and advertised `passwordMinLength`
 *     as 6..256 against the route's 8..128, so it told callers 6 was valid and
 *     the route then refused it.
 *
 * None of those is a logic bug a behavioural test would catch. They are lists
 * failing to match, which is what this file checks mechanically, in the same
 * spirit as `prisma migrate diff --exit-code` and the compose-env guard:
 * compare the artifacts rather than trusting anyone to remember.
 *
 * Fields left out of (2) or (4) on purpose are named in `NOT_PATCHABLE` and
 * `NOT_IN_MCP` below, with the reason. That is the point: an omission is a
 * decision someone wrote down, or it is a failing test.
 */

import { describe, expect, it } from 'vitest';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import {
  AUTH_CONFIG_PATCH_BODY,
  AUTH_CONFIG_PATCH_BODY_JSON_SCHEMA,
} from '../src/modules/tenant-applications/tenant-applications.routes.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';

/**
 * Fields on `AuthConfigSchema` that the operator PATCH route deliberately does
 * NOT accept. Each entry is a decision someone has to justify, which is the
 * point of listing them rather than filtering by shape.
 */
const NOT_PATCHABLE: Record<string, string> = {
  // KNOWN PRODUCT GAP, not an oversight in this test.
  //
  // `webauthn` ({ rpId, rpOrigins, rpName }) is required before any passkey
  // ceremony can run, and no operator surface can set it: not this route, not
  // the panel, not MCP. So `methods: ['passkey']` is settable and then every
  // ceremony fails with WEBAUTHN_NOT_CONFIGURED, whose own `fix` string reads
  // "Set `authConfig.webauthn` ... (Panel → Application → Auth)", an
  // instruction that cannot be followed, because that page has no such field.
  //
  // Making passkeys reachable is a feature (route + panel form + validation of
  // rpId against rpOrigins), not a one-line allowlist entry. Until then this
  // line is the record that the gap is known and where it lives.
  webauthn: 'no operator surface can set it; passkeys are unreachable',
};

/**
 * Fields the REST route accepts that the MCP tool deliberately does not expose.
 */
const NOT_IN_MCP: Record<string, string> = {
  // Legacy, and derived: `AuthConfigSchema`'s transform recomputes it from the
  // resolved `signupMode` after every parse, so a caller setting it directly
  // either agrees with `signupMode` (redundant) or is overwritten (confusing).
  // The route keeps it for old clients; a new surface should not grow it.
  signupEnabled: 'legacy, recomputed from signupMode by the schema transform',

  // WITHHELD ON PURPOSE, and this is the enforcement of that decision rather
  // than a note about it. docs/oidc-provider.md, under "Not built
  // (deliberately)": putting a public authentication surface on the internet
  // is an operator-console decision, not an AI-tool one.
  //
  // Both entries were briefly added to the tool while closing the
  // `hostedAuthorizeUrl` gap, on the reasoning that the panel already exposes
  // them so MCP should too. That reasoning is wrong: the panel is a human
  // holding the operator's session, and the argument in that document is about
  // WHO decides, not about which surface happens to have a control. Reverted.
  oidcEnabled: 'operator-console decision, see docs/oidc-provider.md',
  dynamicClientRegistration: 'operator-console decision, see docs/oidc-provider.md',
};

/**
 * The tool's advertised input schema.
 *
 * Narrowed by assertion rather than by `as never`. A blanket cast satisfies any
 * declared return type, so if `inputSchema` were ever renamed or nested this
 * would still compile and then fail inside the describe body with
 * `Object.keys(undefined)` — a TypeError where a named assertion should be.
 */
function mcpToolProperties(name: string): Record<string, unknown> {
  const tool = operatorWriteTools.find((t) => t.name === name);
  if (!tool) throw new Error(`no operator MCP tool named ${name}`);
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  if (!schema?.properties) {
    throw new Error(`operator MCP tool ${name} has no inputSchema.properties`);
  }
  return schema.properties;
}

describe('auth-config write surfaces agree on their fields', () => {
  // `AuthConfigSchema` ends in a `.transform()`, so the object shape lives on
  // its inner schema rather than on the exported one.
  const schemaKeys = Object.keys(
    (AuthConfigSchema as unknown as { innerType(): { shape: Record<string, unknown> } })
      .innerType()
      .shape,
  );
  const routeKeys = Object.keys(AUTH_CONFIG_PATCH_BODY.shape);
  const toolProps = mcpToolProperties('update_auth_config');
  // `applicationId` names the target, it is not a config field.
  const toolKeys = Object.keys(toolProps).filter((k) => k !== 'applicationId');

  it('the route accepts every storable field except the ones listed as gaps', () => {
    const missing = schemaKeys.filter((k) => !routeKeys.includes(k) && !(k in NOT_PATCHABLE));
    expect(
      missing,
      `AuthConfigSchema declares ${missing.join(', ')}, but the PATCH body is .strict() and ` +
        'would refuse them. Add them to AUTH_CONFIG_PATCH_BODY, or record why not in ' +
        'NOT_PATCHABLE.',
    ).toEqual([]);
  });

  it('the route accepts nothing that cannot actually be stored', () => {
    // The other direction, which is the one that fails silently: a key the
    // route happily accepts and the schema then drops on parse, so the write
    // reports 200 and changes nothing.
    const unstorable = routeKeys.filter((k) => !schemaKeys.includes(k));
    expect(
      unstorable,
      `the PATCH body accepts ${unstorable.join(', ')}, which AuthConfigSchema does not ` +
        'declare, so the value is dropped on parse and the caller is told it worked.',
    ).toEqual([]);
  });

  it('the MCP tool exposes every field the route accepts', () => {
    const missing = routeKeys.filter((k) => !toolKeys.includes(k) && !(k in NOT_IN_MCP));
    expect(
      missing,
      `update_auth_config cannot set ${missing.join(', ')}, so an operator driving Rekey ` +
        'through MCP cannot configure them at all. Add them to the tool, or record why not ' +
        'in NOT_IN_MCP.',
    ).toEqual([]);
  });

  it('the MCP tool does not expose the fields deliberately withheld from it', () => {
    // The assertion the withholding actually rests on, and it was missing.
    //
    // `NOT_IN_MCP` was only ever read as a SKIP LIST by the case above, so
    // adding `oidcEnabled` back to the tool would have passed every test here:
    // the missing-field direction skips it because it is listed, and the
    // unexpected-field direction below passes because it IS a valid route key.
    // Meanwhile this file, decisions.md and docs/oidc-provider.md all claimed
    // re-adding it would fail a test. Three documents asserting a guard that
    // did not exist is worse than no guard, so here it is.
    const leaked = toolKeys.filter((k) => k in NOT_IN_MCP);
    expect(
      leaked,
      `update_auth_config exposes ${leaked.join(', ')}, which is withheld on purpose: ` +
        leaked.map((k) => `${k} (${NOT_IN_MCP[k]})`).join('; '),
    ).toEqual([]);
  });

  it('the MCP tool exposes nothing the route will refuse', () => {
    const rejected = toolKeys.filter((k) => !routeKeys.includes(k));
    expect(
      rejected,
      `update_auth_config advertises ${rejected.join(', ')}, which the PATCH body is ` +
        '.strict() about and will 400 on.',
    ).toEqual([]);
  });

  it('the two surfaces agree on numeric bounds, not just on field names', () => {
    // Names matching is not enough. The tool used to advertise 6..256 for
    // passwordMinLength against the route's 8..128, so it told callers 6 was
    // valid and the route then refused it.
    const bound = toolProps.passwordMinLength as { minimum: number; maximum: number };
    const routeChecks = (
      AUTH_CONFIG_PATCH_BODY.shape.passwordMinLength as unknown as {
        unwrap(): { _def: { checks: Array<{ kind: string; value: number }> } };
      }
    )
      .unwrap()
      ._def.checks;
    const min = routeChecks.find((c) => c.kind === 'min')?.value;
    const max = routeChecks.find((c) => c.kind === 'max')?.value;
    expect({ min: bound.minimum, max: bound.maximum }).toEqual({ min, max });
  });

  it('the published spec documents exactly the fields the route accepts', () => {
    // A THIRD declaration of the same field list, and the one that decides what
    // `openapi.json` says. There is no `additionalProperties: false` on it, so
    // a field missing here still WORKS. It is simply invisible to anyone
    // generating a client, which is how `hostedAuthorizeUrl` shipped, went
    // live, and stayed undiscoverable.
    const documented = Object.keys(AUTH_CONFIG_PATCH_BODY_JSON_SCHEMA.properties);
    const undocumented = routeKeys.filter((k) => !documented.includes(k));
    expect(
      undocumented,
      `the route accepts ${undocumented.join(', ')} but openapi.json does not document ` +
        'them, so no generated client can reach them.',
    ).toEqual([]);

    const phantom = documented.filter((k) => !routeKeys.includes(k));
    expect(
      phantom,
      `openapi.json advertises ${phantom.join(', ')}, which the .strict() body will 400 on.`,
    ).toEqual([]);
  });

  it('the published spec stays valid OpenAPI 3.0', () => {
    // `type: ['string', 'null']` is draft-07 and NOT valid in an OpenAPI 3.0
    // document, which is what this spec declares. Fastify's ajv accepts both,
    // so the mistake is invisible at runtime and only shows up as every real
    // spec validator rejecting the published file. It has happened once, on
    // `appUrl`; `nullable: true` is the 3.0 spelling.
    const arrayTyped = Object.entries(AUTH_CONFIG_PATCH_BODY_JSON_SCHEMA.properties)
      .filter(([, v]) => Array.isArray((v as { type?: unknown }).type))
      .map(([k]) => k);
    expect(
      arrayTyped,
      `${arrayTyped.join(', ')} use the draft-07 type-array form. OpenAPI 3.0 wants ` +
        "`type: 'string', nullable: true`.",
    ).toEqual([]);
  });

  it('the MCP tool documents the sign-in redirect it can now set', () => {
    // hostedAuthorizeUrl points the browser somewhere during sign-in, which is
    // a phishing surface if it is set carelessly. It is the one field here
    // whose description has to carry that warning, so an MCP client's model
    // reads it before choosing a value.
    const field = toolProps.hostedAuthorizeUrl as { description?: string };
    expect(field).toBeDefined();
    expect(field.description ?? '').toMatch(/SECURITY/);
  });
});
