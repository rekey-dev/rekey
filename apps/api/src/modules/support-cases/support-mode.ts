/**
 * Support mode as a session or the application's backend reads it. One query,
 * and only when a caller asks: `/auth/me` without `include=support` never
 * reaches this.
 */

import type { SupportModeDto } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import type { JsonSchema } from '../../lib/openapi.js';

const INACTIVE: SupportModeDto = { active: false, capabilities: [] };

/**
 * A `DEVICES` case is active only for a device it names, so no `deviceId`
 * reads it as inactive. A device id from another end-user can never be in the
 * list, because opening and changing a case accept only this end-user's own.
 *
 * @example
 *   const support = await supportModeFor({ applicationId, endUserId, deviceId: req.deviceId });
 *   if (support.active && support.capabilities.includes('diagnostics.debug')) { ... }
 */
export async function supportModeFor(args: {
  applicationId: string;
  endUserId: string;
  deviceId?: string | null | undefined;
}): Promise<SupportModeDto> {
  const open = await prisma.supportCase.findFirst({
    where: { applicationId: args.applicationId, endUserId: args.endUserId, status: 'OPEN' },
    select: { capabilities: true, scope: true, deviceIds: true, openedAt: true, updatedAt: true },
  });
  if (!open) return INACTIVE;
  const coversThisDevice = typeof args.deviceId === 'string' && open.deviceIds.includes(args.deviceId);
  if (open.scope === 'DEVICES' && !coversThisDevice) return INACTIVE;
  return {
    active: true,
    capabilities: open.capabilities,
    scope: open.scope === 'DEVICES' ? 'device' : 'user',
    since: open.openedAt.toISOString(),
    updatedAt: open.updatedAt.toISOString(),
  };
}

export const SUPPORT_MODE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    active: { type: 'boolean' },
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description: "Capability names from the Application's catalogue, sorted. Empty when inactive.",
    },
    scope: {
      type: 'string',
      enum: ['user', 'device'],
      description: 'Present when active. `device` when the case is limited to named devices and this is one of them.',
    },
    since: { type: 'string', format: 'date-time', description: 'Present when active. When the case was opened.' },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'Present when active. When its capabilities or devices last changed; cache on this.',
    },
  },
  required: ['active', 'capabilities'],
};
