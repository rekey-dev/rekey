/**
 * Operator MCP tools for profile fields (the onboarding questions) and one
 * end user's answers. Each is the twin of a route in
 * `end-users/profile-tenant.routes.ts` and calls the same service.
 */

import { z } from 'zod';
import { accessContextFromTool, applicationAccess } from '../../lib/access-context.js';
import { assertEndUserInApplication } from '../../lib/end-users.js';
import { profileService } from '../end-users/profile.service.js';
import { profileState } from '../end-users/profile.routes.js';
import type { OperatorToolContext } from './operator-tools.js';
import { ApplicationIdArg, JsonValueSchema, defineTool } from './tool-definition.js';
import { auditOperatorWrite, loadAppInTenant } from './operator-write-tools.js';

const EndUserIdArg = z.string().min(1).max(200).describe('The end user id, from get_end_user.');
const UserArgs = z.object({ applicationId: ApplicationIdArg, endUserId: EndUserIdArg }).strict();

async function appFor(ctx: OperatorToolContext, applicationId: string, need: 'read' | 'write') {
  const app = await loadAppInTenant(ctx, applicationId);
  await applicationAccess(accessContextFromTool(ctx), app.id, need, {
    scope: need === 'read' ? 'end-users:read' : 'end-users:write',
  });
  return app;
}

async function userIn(ctx: OperatorToolContext, applicationId: string, endUserId: string) {
  const app = await appFor(ctx, applicationId, 'write');
  await assertEndUserInApplication(app.id, endUserId, 'Use get_end_user to find the id.');
  return app;
}

export const operatorProfileTools = [
  defineTool({
    name: 'get_profile_schema',
    description:
      "An application's profile fields (its onboarding questions), in order, with the `version` to send " +
      'back to set_profile_schema.',
    args: z.object({ applicationId: ApplicationIdArg }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, { applicationId }) => {
      const app = await appFor(ctx, applicationId, 'read');
      return profileService.schemaWithVersion(app.id);
    },
  }),
  defineTool({
    name: 'set_profile_schema',
    description:
      "Replace an application's profile fields (the whole list). Read them with get_profile_schema first " +
      'and send its `version`, so the write is refused (PROFILE_SCHEMA_CHANGED) if someone saved in between. ' +
      'A field users have answered keeps its key and type (PROFILE_FIELD_KEY_IMMUTABLE), and a select option ' +
      'users picked cannot be removed (PROFILE_OPTION_IN_USE). Labels, flags and new options change freely.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        fields: z
          .array(z.record(JsonValueSchema))
          .max(50)
          .describe('The fields, in order, each shaped like one get_profile_schema returns.'),
        version: z.number().int().min(0).optional().describe('The `version` get_profile_schema returned.'),
      })
      .strict(),
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, fields, version }) => {
      const app = await appFor(ctx, applicationId, 'write');
      const stored = await profileService.putSchema(app.id, fields, version);
      auditOperatorWrite(ctx, 'app.profile_schema_updated', app.id, {
        keys: stored.fields.map((f) => f.key),
        version: stored.version,
      });
      return stored;
    },
  }),
  defineTool({
    name: 'update_end_user_profile',
    description:
      "Set an end user's profile answers, including fields only your server may write. Keys you omit are " +
      'kept; null clears an answer. Emits user.updated with via "operator" when an answer changed.',
    args: UserArgs.extend({
      profile: z.record(JsonValueSchema).describe('Answers keyed by field key, from get_profile_schema.'),
    }).strict(),
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, endUserId, profile }) => {
      const app = await userIn(ctx, applicationId, endUserId);
      const state = await profileService.update({
        applicationId: app.id,
        endUserId,
        patch: profile,
        writer: 'server',
        via: 'operator',
      });
      return profileState(state);
    },
  }),
  defineTool({
    name: 'complete_onboarding',
    description:
      "Mark an end user's onboarding complete. Every required field must be answered (PROFILE_INCOMPLETE " +
      'lists the missing keys). Emits user.onboarding_completed the first time. Onboarding never gates sign-in.',
    args: UserArgs,
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, endUserId }) => {
      const app = await userIn(ctx, applicationId, endUserId);
      return profileState(
        await profileService.completeOnboarding({ applicationId: app.id, endUserId, via: 'operator' }),
      );
    },
  }),
  defineTool({
    name: 'skip_onboarding',
    description:
      'Record that an end user skipped onboarding. The first skip emits user.onboarding_skipped; a repeat, ' +
      'or a skip after completion, changes nothing.',
    args: UserArgs,
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { applicationId, endUserId }) => {
      const app = await userIn(ctx, applicationId, endUserId);
      return profileState(await profileService.skipOnboarding({ applicationId: app.id, endUserId, via: 'operator' }));
    },
  }),
];
