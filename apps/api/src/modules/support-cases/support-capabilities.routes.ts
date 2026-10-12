/**
 * Operator routes for an Application's support capability catalogue,
 * `/api/v1/tenant/applications/:id/support-capabilities`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, okArray, okFlag, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { OPERATOR_END_USER_ERRORS } from '../end-user-bans/end-user-bans.routes.js';
import {
  SUPPORT_CAPABILITY_DESCRIPTION_MAX,
  SUPPORT_CAPABILITY_LIMIT,
  SUPPORT_CAPABILITY_NAME_MAX,
  supportCapabilitiesService,
} from './support-capabilities.service.js';

const AppParams = z.object({ id: z.string().min(1) });
const NameParams = AppParams.extend({ name: z.string().min(1) });
const Description = z.string().max(SUPPORT_CAPABILITY_DESCRIPTION_MAX);
// The name's shape is checked by the service, so a bad one gets
// SUPPORT_CAPABILITY_NAME_INVALID and its fix, not a schema error.
const CreateBody = z.object({ name: z.string(), description: Description.optional() }).strict();

const APP_PARAMS_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
const NAME_PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' } },
  required: ['id', 'name'],
} as const;

const CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'applicationId', 'name', 'description', 'createdAt', 'updatedAt'],
} as const;

const DESCRIPTION_BODY = {
  type: 'string',
  maxLength: SUPPORT_CAPABILITY_DESCRIPTION_MAX,
  description: 'What the capability does in your application, for the operators who pick it.',
} as const;

const ERRORS = {
  401: OPERATOR_END_USER_ERRORS[401],
  403: OPERATOR_END_USER_ERRORS[403],
  404:
    'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
    'MEMBER holding no grant on it).',
} as const;

const NOT_FOUND = `${ERRORS[404]} Or SUPPORT_CAPABILITY_NOT_FOUND: no capability with that name in this Application.`;

export async function tenantSupportCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/support-capabilities',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "List an Application's support capabilities",
        description:
          'Requires **read** access to this Application. The names an operator can put on a ' +
          'support case, alphabetical. Your application decides what each one means.',
        params: APP_PARAMS_SCHEMA,
        response: {
          // Bounded by construction: the catalogue holds 100 names at most.
          200: okArray(CAPABILITY_SCHEMA, 'The catalogue.'),
          ...errs(ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParams.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await supportCapabilitiesService.list(id) };
    },
  );

  app.post(
    '/:id/support-capabilities',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Add a support capability to the catalogue',
        description:
          'Requires **write** access to this Application. The name is what your application ' +
          'checks for, so it cannot be renamed later.',
        params: APP_PARAMS_SCHEMA,
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              description:
                `1 to ${SUPPORT_CAPABILITY_NAME_MAX} characters: lowercase letters and digits in groups ` +
                'joined by a single dot, hyphen or underscore, for example `diagnostics.debug`.',
            },
            description: DESCRIPTION_BODY,
          },
        },
        response: {
          201: ok(CAPABILITY_SCHEMA, 'The created capability.'),
          ...errs({
            ...ERRORS,
            400:
              'SUPPORT_CAPABILITY_NAME_INVALID: the name does not match the allowed shape; or ' +
              `BAD_REQUEST: \`name\` is missing or \`description\` is longer than ${SUPPORT_CAPABILITY_DESCRIPTION_MAX} characters.`,
            409:
              'SUPPORT_CAPABILITY_NAME_TAKEN: the catalogue already has that name; or ' +
              `SUPPORT_CAPABILITY_LIMIT: the catalogue already holds ${SUPPORT_CAPABILITY_LIMIT} names.`,
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = CreateBody.parse(req.body ?? {});
      const created = await supportCapabilitiesService.create({
        applicationId: id,
        name: body.name,
        description: body.description,
      });
      return reply.status(201).send({ success: true, data: created });
    },
  );

  app.delete(
    '/:id/support-capabilities/:name',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Delete a support capability',
        description:
          'Requires **write** access to this Application. Refused while an open support case ' +
          'uses the name. Closed cases keep it as history.',
        params: NAME_PARAMS_SCHEMA,
        response: {
          200: okFlag('The capability was deleted.'),
          ...errs({
            ...ERRORS,
            404: NOT_FOUND,
            409: 'SUPPORT_CAPABILITY_IN_USE: an open support case uses the name; the message says how many.',
          }),
        },
      },
    },
    async (req) => {
      const { id, name } = NameParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await supportCapabilitiesService.remove({ applicationId: id, name });
      return { success: true, data: { ok: true } };
    },
  );
}
