/**
 * Operator routes for contacts, under /api/v1/tenant/applications/:id/contacts.
 * Erase is a floor: the workspace OWNER only, and no grant or scope unlocks
 * it, the same posture as end-user erasure.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RekeyError } from '../../lib/error.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok } from '../../lib/openapi.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { requireTenantRole, requireTenantSession } from '../../middleware/tenant-session.js';
import { eraseContact } from './contact-erasure.service.js';

const ContactParam = z.object({ id: z.string().min(1), contactId: z.string().min(1) });

const TAGS = ['Tenant · Lists'];
const SECURITY = [{ tenantSession: [] }];

export async function tenantContactsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.delete(
    '/:id/contacts/:contactId',
    {
      config: { access: { floor: true } },
      preHandler: requireTenantRole(['OWNER']),
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Erase a contact (GDPR)',
        description:
          'Requires the **workspace OWNER** role; no grant or scope unlocks it, and neither does ADMIN. Hard-deletes ' +
          'the contact with every list membership and submission, and rewrites the address, name and ' +
          'submitted fields in stored webhook deliveries that named it. Cannot be undone. An end user ' +
          'at the same address is not touched; erasing an end user erases their contact too.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                erased: { type: 'boolean' },
                webhookDeliveriesScrubbed: { type: 'integer' },
              },
              required: ['erased', 'webhookDeliveriesScrubbed'],
            },
            'The contact is gone.',
          ),
          ...errs({
            401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
            403: 'TENANT_ROLE_INSUFFICIENT: requires the workspace OWNER role.',
            404:
              'APPLICATION_NOT_FOUND: no Application with that id in this workspace; or ' +
              'CONTACT_NOT_FOUND: no contact with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, contactId } = ContactParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const result = await eraseContact(id, contactId);
      if (!result) {
        throw new RekeyError({
          statusCode: 404,
          code: 'CONTACT_NOT_FOUND',
          message: 'No contact with that id in this Application.',
          fix: 'Check the id. A contact id is `contactId` in a secret-key subscribe response and `data.contact.id` in contact.* webhooks.',
        });
      }
      void recordSecurityEvent({
        type: 'contact.erased',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { contactId, webhookDeliveriesScrubbed: result.deliveriesScrubbed },
      });
      return { success: true, data: { erased: true, webhookDeliveriesScrubbed: result.deliveriesScrubbed } };
    },
  );
}
