/**
 * Device management routes, three surfaces over one service.
 *
 *   devicesUserRoutes      /api/v1/users/me/devices
 *     The end-user's own devices. Publishable key + user JWT, like the rest
 *     of `/users/me`: a desktop app listing "your signed-in machines" and
 *     releasing one is the whole use case, and the JWT is the authorizer.
 *
 *   devicesServerRoutes    /api/v1/devices
 *     Secret-key-only. For the customer's OWN backend, which holds a secret
 *     key but not the user's token, a support tool, a licence server, a
 *     migration script. Addresses devices by end-user id.
 *
 *   tenantDevicesRoutes    /api/v1/tenant/applications/:id/end-users/:euid/devices
 *     Operator surface: list, release, block, unblock. Block and unblock live
 *     here ONLY, they are operator decisions, and neither the end-user nor a
 *     secret key can make them.
 *
 * Every route resolves the device through `devicesService`, which scopes by
 * (application, end-user) and 404s across either boundary, so an id from
 * another application or another user is indistinguishable from a typo.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import {
  requireApiKey,
  requirePublishableOrSecretKey,
  requireScope,
} from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { devicesService, forEndUser } from './devices.service.js';
import { assertEndUserInApplication } from '../../lib/end-users.js';
import { recordSecurityEvent } from '../../lib/security-events.js';

const DeviceIdParam = z.object({ id: z.string().min(1) });
const StatusQuery = z.object({
  status: z.enum(['ACTIVE', 'RELEASED', 'BLOCKED']).optional(),
});
const STATUS_QUERY_SCHEMA = {
  status: { type: 'string', enum: ['ACTIVE', 'RELEASED', 'BLOCKED'] },
} as const;

// ---------------------------------------------------------------------------
// End-user surface
// ---------------------------------------------------------------------------

const USER_ERRORS = {
  401:
    'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID — the Application key is missing ' +
    'or unknown; or USER_TOKEN_MISSING / USER_TOKEN_INVALID / USER_TOKEN_WRONG_APPLICATION — the ' +
    'user JWT is missing, invalid, or issued by another Application.',
  403:
    "IP_NOT_ALLOWED — a secret-key caller's IP is outside the allowlist; or ORIGIN_NOT_ALLOWED — a " +
    "publishable-key caller's Origin is outside the CORS allowlist; or API_KEY_SCOPE_INSUFFICIENT.",
} as const;

export async function devicesUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:read'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Devices'],
        summary: "List the current end-user's devices",
        description:
          'Every device this end-user has signed in from, newest activity first. Filter with ' +
          '`?status=ACTIVE|RELEASED|BLOCKED`. The device the current session is bound to is the ' +
          "one whose id matches the access token's `dev` claim. Operator notes and IPs are not " +
          'included on this surface.',
        security: [{ publishableKey: [], userToken: [] }, { apiKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { ...STATUS_QUERY_SCHEMA, ...paginationJsonSchema } },
        response: {
          200: okPage(ref('EndUserDevice'), "A page of the end-user's devices."),
          ...errs({ 400: 'VALIDATION_ERROR — a query parameter is out of range.', ...USER_ERRORS }),
        },
      },
    },
    async (req) => {
      const { status } = StatusQuery.parse(req.query);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await devicesService.listForEndUser(
        req.application!.id,
        req.endUser!.id,
        { status, take, skip },
      );
      return { success: true, data: paged(items.map(forEndUser), total, take, skip) };
    },
  );

  app.delete(
    '/:id',
    {
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Devices'],
        summary: 'Release one of your devices',
        description:
          'Gives the slot back and revokes every session minted on that device, including the ' +
          'current one, if it is the same device. Idempotent for an already-released device. A ' +
          'BLOCKED device cannot be released by its owner; an operator has to unblock it first.',
        security: [{ publishableKey: [], userToken: [] }, { apiKey: [], userToken: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                device: ref('EndUserDevice'),
                sessionsRevoked: { type: 'integer' },
              },
              required: ['device', 'sessionsRevoked'],
            },
            'The released device and how many sessions ended with it.',
          ),
          ...errs({
            ...USER_ERRORS,
            404: 'DEVICE_NOT_FOUND — no device with that id belongs to this end-user.',
            409: 'DEVICE_BLOCKED — the device is blocked; only an operator can unblock it.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = DeviceIdParam.parse(req.params);
      const result = await devicesService.release({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        deviceId: id,
        actor: { type: 'end_user', id: req.endUser!.id },
      });
      return {
        success: true,
        data: { device: forEndUser(result.device), sessionsRevoked: result.sessionsRevoked },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Secret-key surface
// ---------------------------------------------------------------------------

const SERVER_ERRORS = {
  401: 'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, unknown, revoked, or expired (a publishable key is refused here).',
  403: "IP_NOT_ALLOWED — the caller's IP is outside the key's allowlist; or API_KEY_SCOPE_INSUFFICIENT — the key lacks the required scope.",
} as const;

const EndUserQuery = z.object({ endUserId: z.string().min(1) });
const BlockBody = z.object({ reason: z.string().max(500).optional() });

export async function devicesServerRoutes(app: FastifyInstance): Promise<void> {
  // Secret key only: this surface reads and mutates OTHER users' devices,
  // which a browser-shipped publishable key must never be able to do.
  app.addHook('onRequest', requireApiKey);

  app.get(
    '/',
    {
      onRequest: requireScope('auth:read'),
      schema: {
        tags: ['Public · Devices'],
        summary: "List an end-user's devices (server-side)",
        description:
          'For your own backend, which holds a secret key but not the user\'s token. ' +
          'Requires `?endUserId=`; filter with `?status=`. Includes `lastSeenIp` and ' +
          '`blockedReason`, so treat the response as operator-grade data.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          required: ['endUserId'],
          properties: {
            endUserId: { type: 'string', minLength: 1 },
            ...STATUS_QUERY_SCHEMA,
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(ref('Device'), "A page of the end-user's devices."),
          ...errs({
            400: 'VALIDATION_ERROR — `endUserId` is missing or a query parameter is out of range.',
            ...SERVER_ERRORS,
            404: 'END_USER_NOT_FOUND — no end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { endUserId } = EndUserQuery.parse(req.query);
      const { status } = StatusQuery.parse(req.query);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      await assertEndUserInApplication(req.application!.id, endUserId);
      const { items, total } = await devicesService.listForEndUser(req.application!.id, endUserId, {
        status,
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/release',
    {
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Devices'],
        summary: "Release an end-user's device (server-side)",
        description:
          'Gives the slot back and revokes every session minted on the device. `endUserId` in the ' +
          'body scopes the lookup, so a device id from another user 404s rather than being acted on.',
        security: [{ apiKey: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['endUserId'],
          properties: { endUserId: { type: 'string', minLength: 1 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { device: ref('Device'), sessionsRevoked: { type: 'integer' } },
              required: ['device', 'sessionsRevoked'],
            },
            'The released device and how many sessions ended with it.',
          ),
          ...errs({
            ...SERVER_ERRORS,
            404: 'DEVICE_NOT_FOUND — no device with that id belongs to that end-user in this Application.',
            409: 'DEVICE_BLOCKED — the device is blocked; only an operator can unblock it.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = DeviceIdParam.parse(req.params);
      const { endUserId } = EndUserQuery.parse(req.body);
      const result = await devicesService.release({
        applicationId: req.application!.id,
        endUserId,
        deviceId: id,
        actor: { type: 'server', id: req.apiKey?.id ?? null },
      });
      return { success: true, data: result };
    },
  );
}

// ---------------------------------------------------------------------------
// Operator surface
// ---------------------------------------------------------------------------

const TENANT_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or TENANT_SESSION_INVALID — ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED — the operator\'s grant on this Application ' +
    'does not permit this action.',
  404:
    'APPLICATION_NOT_FOUND — no application with that id in this workspace (also returned to a ' +
    'MEMBER holding no grant on it); or END_USER_NOT_FOUND — no end-user with that id in this ' +
    'Application; or DEVICE_NOT_FOUND — no device with that id belongs to that end-user.',
} as const;

const TenantParams = z.object({ id: z.string().min(1), euid: z.string().min(1) });
const TenantDeviceParams = TenantParams.extend({ deviceId: z.string().min(1) });
const TENANT_PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, euid: { type: 'string' } },
  required: ['id', 'euid'],
} as const;
const TENANT_DEVICE_PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, euid: { type: 'string' }, deviceId: { type: 'string' } },
  required: ['id', 'euid', 'deviceId'],
} as const;

const DEVICE_WITH_SESSIONS = {
  type: 'object',
  properties: { device: ref('Device'), sessionsRevoked: { type: 'integer' } },
  required: ['device', 'sessionsRevoked'],
} as const;

export async function tenantDevicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/end-users/:euid/devices',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · Devices'],
        security: [{ tenantSession: [] }],
        summary: "List an end-user's devices",
        description:
          'Requires **read** access to this Application. Every device the end-user has signed in ' +
          'from, newest activity first, including released and blocked ones; filter with `?status=`.',
        params: TENANT_PARAMS_SCHEMA,
        querystring: { type: 'object', properties: { ...STATUS_QUERY_SCHEMA, ...paginationJsonSchema } },
        response: {
          200: okPage(ref('Device'), "A page of the end-user's devices."),
          ...errs({ 400: 'VALIDATION_ERROR — a query parameter is out of range.', ...TENANT_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id, euid } = TenantParams.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      await assertEndUserInApplication(id, euid);
      const { status } = StatusQuery.parse(req.query);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await devicesService.listForEndUser(id, euid, { status, take, skip });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/end-users/:euid/devices/:deviceId/release',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · Devices'],
        security: [{ tenantSession: [] }],
        summary: "Release an end-user's device",
        description:
          'Requires **write** access to this Application. Gives the slot back and revokes every ' +
          'session minted on the device. Idempotent. A BLOCKED device must be unblocked first.',
        params: TENANT_DEVICE_PARAMS_SCHEMA,
        response: {
          200: ok(DEVICE_WITH_SESSIONS, 'The released device and how many sessions ended with it.'),
          ...errs({
            ...TENANT_ERRORS,
            409: 'DEVICE_BLOCKED — the device is blocked; unblock it first.',
          }),
        },
      },
    },
    async (req) => {
      const { id, euid, deviceId } = TenantDeviceParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const result = await devicesService.release({
        applicationId: id,
        endUserId: euid,
        deviceId,
        actor: { type: 'operator', id: req.tenantUser?.id ?? null },
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/:id/end-users/:euid/devices/release-all',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · Devices'],
        security: [{ tenantSession: [] }],
        summary: "Release every one of an end-user's active devices",
        description:
          'Requires **write** access to this Application. The "I have changed laptop and cannot ' +
          'sign in" button: frees every ACTIVE slot at once and revokes the sessions minted on ' +
          'them, so the next sign-in from any machine is admitted.\n\n' +
          'BLOCKED devices are deliberately left alone, a block is an operator decision about one ' +
          'machine, and a bulk convenience must not quietly undo it. Unblock those individually. ' +
          'RELEASED ones are already free and are skipped.\n\n' +
          'Idempotent: an end-user with nothing active answers `released: 0`.',
        params: TENANT_PARAMS_SCHEMA,
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                released: { type: 'integer', description: 'Devices moved from ACTIVE to RELEASED.' },
                sessionsRevoked: {
                  type: 'integer',
                  description: 'Sessions ended across all of them.',
                },
                skippedBlocked: {
                  type: 'integer',
                  description:
                    'BLOCKED devices left untouched, so the count is not silently short. Includes any blocked while the sweep ran.',
                },
                capped: {
                  type: 'boolean',
                  description:
                    'Present only when the sweep hit its 50-pass limit, which means devices were still being re-activated as it ran. Run it again.',
                },
              },
              required: ['released', 'sessionsRevoked', 'skippedBlocked'],
            },
            'What was released, and what was deliberately not.',
          ),
          ...errs(TENANT_ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid } = TenantParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await assertEndUserInApplication(id, euid);

      const blocked = await devicesService.listForEndUser(id, euid, { status: 'BLOCKED', take: 1 });
      let released = 0;
      let sessionsRevoked = 0;
      // Seeded from devices already blocked when the sweep began, and added to
      // by any that get blocked while it runs.
      let skippedBlocked = blocked.total;
      // Re-query rather than paging with an offset: every release moves a row
      // OUT of this filter, so a second page computed against the first
      // window would skip devices. `release` takes the per-user advisory lock
      // itself, so these calls are sequential by construction.
      //
      // The pass cap is not for loop termination (every release already moves
      // a row out of the ACTIVE filter). It exists because `devicesService.touch`
      // puts a RELEASED device back to ACTIVE, so a client signing in mid-sweep
      // adds work: a busy account could keep this request running past an
      // operator's patience or a proxy's timeout. 50 passes of 100 is 5000
      // devices, well past any real end-user.
      let passes = 0;
      let capped = false;
      for (;;) {
        const { items } = await devicesService.listForEndUser(id, euid, {
          status: 'ACTIVE',
          take: 100,
        });
        // Checked AFTER the listing, so a sweep that legitimately drained
        // everything on its fiftieth pass reports success rather than a
        // cap it never hit.
        if (items.length === 0) break;
        if (passes >= 50) {
          capped = true;
          break;
        }
        passes += 1;
        for (const device of items) {
          // A device somebody BLOCKS mid-sweep makes `release` throw 409.
          // Aborting the request there would discard the count of everything
          // already released and write no summary event, the operator would
          // see an error for a reset that half happened. It belongs in the
          // skipped tally instead, which is what a blocked device is.
          let result;
          try {
            result = await devicesService.release({
              applicationId: id,
              endUserId: euid,
              deviceId: device.id,
              actor: { type: 'operator', id: req.tenantUser?.id ?? null },
            });
          } catch (e) {
            if ((e as { code?: string }).code === 'DEVICE_BLOCKED') {
              skippedBlocked += 1;
              continue;
            }
            throw e;
          }
          released += 1;
          sessionsRevoked += result.sessionsRevoked;
        }
      }

      // One summary row on top of the per-device `device.released` events the
      // service already writes. The trail should say "an operator reset this
      // person's devices" rather than leave somebody to infer it from six rows
      // that happen to share a timestamp.
      if (released > 0) {
        void recordSecurityEvent({
          type: 'end_user.devices_released_by_operator',
          actorType: 'operator',
          actorId: req.tenantUser?.id ?? null,
          tenantId: req.tenantId ?? null,
          applicationId: id,
          metadata: { endUserId: euid, released, sessionsRevoked, skippedBlocked, ...(capped && { capped: true }) },
        });
      }
      return { success: true, data: { released, sessionsRevoked, skippedBlocked, ...(capped && { capped: true }) } };
    },
  );

  app.post(
    '/:id/end-users/:euid/devices/:deviceId/block',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · Devices'],
        security: [{ tenantSession: [] }],
        summary: 'Block a device',
        description:
          'Requires **write** access to this Application. Sign-in from this fingerprint is refused ' +
          '(DEVICE_BLOCKED) until unblocked; every session on the device is revoked now. The ' +
          '`reason` is operator-facing only, the end-user never sees it. Idempotent.',
        params: TENANT_DEVICE_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
        },
        response: {
          200: ok(DEVICE_WITH_SESSIONS, 'The blocked device and how many sessions ended with it.'),
          ...errs(TENANT_ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid, deviceId } = TenantDeviceParams.parse(req.params);
      const body = BlockBody.parse(req.body ?? {});
      await ensureAppAccess(req, id, 'write');
      const result = await devicesService.block({
        applicationId: id,
        endUserId: euid,
        deviceId,
        reason: body.reason,
        operatorUserId: req.tenantUser?.id ?? null,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/:id/end-users/:euid/devices/:deviceId/unblock',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · Devices'],
        security: [{ tenantSession: [] }],
        summary: 'Unblock a device',
        description:
          'Requires **write** access to this Application. The device comes back as RELEASED, not ' +
          'ACTIVE: it takes a slot again only on its next sign-in, and only if the limit allows. ' +
          'Idempotent.',
        params: TENANT_DEVICE_PARAMS_SCHEMA,
        response: {
          200: ok(ref('Device'), 'The device, now RELEASED.'),
          ...errs(TENANT_ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid, deviceId } = TenantDeviceParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const device = await devicesService.unblock({
        applicationId: id,
        endUserId: euid,
        deviceId,
        operatorUserId: req.tenantUser?.id ?? null,
      });
      return { success: true, data: device };
    },
  );

}
