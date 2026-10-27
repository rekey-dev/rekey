/**
 * Operator MCP tools that set up lists and look after the people on them.
 * Each is the twin of a route in `contacts/tenant-lists.routes.ts` or
 * `contacts/tenant-list-members.routes.ts` and calls the same service.
 *
 * Members and submissions come back a page at a time. The CSV export stays
 * panel-only, and there is still no erase tool.
 */

import { z } from 'zod';
import { CONTACT_LIST_KEY_RE, LIST_MEMBER_STATUSES } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { accessContextFromTool, applicationAccess } from '../../lib/access-context.js';
import { prisma } from '../../lib/prisma.js';
import { listsService } from '../contacts/lists.service.js';
import { operatorMembers, operatorSubmissions, operatorUnsubscribe } from '../contacts/list-reads.service.js';
import { listSettingsShape } from '../contacts/tenant-lists.routes.js';
import type { OperatorToolContext } from './operator-tools.js';
import { ApplicationIdArg, defineTool } from './tool-definition.js';
import { auditOperatorWrite, loadAppInTenant } from './operator-write-tools.js';

const PAGE_MAX = 100;

const ListKeyArg = z.string().min(1).max(64).describe('The list key, from list_contact_lists.');
const ListArgs = z.object({ applicationId: ApplicationIdArg, key: ListKeyArg }).strict();
const PageArgs = {
  limit: z.number().int().min(1).max(PAGE_MAX).default(25),
  offset: z.number().int().min(0).default(0),
};

async function appFor(ctx: OperatorToolContext, applicationId: string, need: 'read' | 'write') {
  const app = await loadAppInTenant(ctx, applicationId, need);
  await applicationAccess(accessContextFromTool(ctx), app.id, need, {
    scope: need === 'read' ? 'audience:read' : 'audience:write',
  });
  return app;
}

async function listIn(ctx: OperatorToolContext, applicationId: string, key: string, need: 'read' | 'write') {
  const app = await appFor(ctx, applicationId, need);
  const list = await prisma.contactList.findUnique({
    where: { applicationId_key: { applicationId: app.id, key } },
    select: { id: true },
  });
  if (!list) {
    throw new RekeyError({
      statusCode: 404,
      code: 'LIST_NOT_FOUND',
      message: `No list "${key}" in this application.`,
      fix: 'Call list_contact_lists with this applicationId to see the keys.',
    });
  }
  return { appId: app.id, listId: list.id };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const operatorListTools = [
  defineTool({
    name: 'create_contact_list',
    description:
      'Create a list (waitlist, newsletter, contact form) on an application. `key` is permanent and is how ' +
      'the SDK and the public routes name the list. A new list refuses publishable keys until ' +
      'update_contact_list turns publicCapture on. Refused at the workspace maxContactLists limit.',
    args: z
      .object({ applicationId: ApplicationIdArg, key: z.string().regex(CONTACT_LIST_KEY_RE), ...listSettingsShape })
      .partial()
      .required({ applicationId: true, key: true, name: true })
      .strict(),
    write: true,
    annotations: { ...WRITE, idempotentHint: false },
    run: async (ctx, { applicationId, ...settings }) => {
      const app = await appFor(ctx, applicationId, 'write');
      const list = await listsService.create(ctx.tenantId, app.id, ctx.tenantUserId, settings);
      auditOperatorWrite(ctx, 'app.contact_list.created', app.id, { listId: list.id, key: list.key });
      return list;
    },
  }),
  defineTool({
    name: 'update_contact_list',
    description:
      "Change a list's settings: name, description, kind, fields, lawful basis, consent text, disposable " +
      'address blocking, submission retention, Public capture. Only the fields sent change. New consent text ' +
      'becomes the next consentVersion. publicCapture needs a browser origin on the application ' +
      '(LIST_CAPTURE_UNPROTECTED otherwise).',
    args: z
      .object({ ...listSettingsShape, publicCapture: z.boolean() })
      .partial()
      .extend({ applicationId: ApplicationIdArg, key: ListKeyArg })
      .strict(),
    write: true,
    annotations: WRITE,
    run: async (ctx, { applicationId, key, ...patch }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'write');
      const { list, changed } = await listsService.update(appId, listId, ctx.tenantUserId, patch);
      if (changed.length > 0) auditOperatorWrite(ctx, 'app.contact_list.updated', appId, { listId, key, changed });
      return list;
    },
  }),
  defineTool({
    name: 'archive_contact_list',
    description:
      'Archive a list: it refuses every subscribe, keeps its members and submissions, and stops counting ' +
      'toward maxContactLists. Undo with restore_contact_list.',
    args: ListArgs,
    write: true,
    annotations: WRITE,
    run: async (ctx, { applicationId, key }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'write');
      const { list, changed } = await listsService.archive(appId, listId);
      if (changed) auditOperatorWrite(ctx, 'app.contact_list.archived', appId, { listId, key });
      return list;
    },
  }),
  defineTool({
    name: 'restore_contact_list',
    description:
      'Restore an archived list. It counts toward maxContactLists again, so this can be refused at the limit.',
    args: ListArgs,
    write: true,
    annotations: WRITE,
    run: async (ctx, { applicationId, key }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'write');
      const { list, changed } = await listsService.restore(ctx.tenantId, appId, listId);
      if (changed) auditOperatorWrite(ctx, 'app.contact_list.restored', appId, { listId, key });
      return list;
    },
  }),
  defineTool({
    name: 'list_list_members',
    description:
      "A page of a list's members, newest first, with email, status, how they joined and their consent " +
      'proof. Filter by status or search by email or name. Use memberId with unsubscribe_list_member.',
    args: ListArgs.extend({
      status: z.enum(LIST_MEMBER_STATUSES).optional(),
      search: z.string().trim().min(1).max(254).optional().describe('Part of an email address or name.'),
      ...PageArgs,
    }).strict(),
    // Addresses in an agent's context: owners and admins only, whatever a member's grant.
    minRole: 'ADMIN',
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, key, status, search, limit, offset }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'read');
      return operatorMembers(appId, listId, { status, search, take: limit, skip: offset });
    },
  }),
  defineTool({
    name: 'list_list_submissions',
    description: "A page of a list's stored form submissions, newest first, each with the sender's email.",
    args: ListArgs.extend(PageArgs).strict(),
    // Addresses in an agent's context: owners and admins only, whatever a member's grant.
    minRole: 'ADMIN',
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, key, limit, offset }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'read');
      return operatorSubmissions(appId, listId, { take: limit, skip: offset });
    },
  }),
  defineTool({
    name: 'unsubscribe_list_member',
    description:
      'Take someone off a list. Sends contact.unsubscribed once; repeating it changes nothing. There is no ' +
      're-subscribe: only the person, through your server with consent, can join again.',
    args: ListArgs.extend({
      memberId: z.string().min(1).max(200).describe('The memberId, from list_list_members.'),
    }).strict(),
    write: true,
    annotations: { ...WRITE, destructiveHint: true },
    run: async (ctx, { applicationId, key, memberId }) => {
      const { appId, listId } = await listIn(ctx, applicationId, key, 'write');
      return (await operatorUnsubscribe(appId, listId, memberId)).member;
    },
  }),
];
