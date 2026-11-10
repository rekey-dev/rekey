/**
 * Account changes a signed-in end-user proves with their mailbox: asking for
 * an emailed code, and setting a first password with it. Registered inside
 * `authenticatedAuthRoutes`, so each route runs that plugin's key, scope and
 * user-session hooks.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRateLimit } from '../../lib/rate-limit.js';
import { ok, okFlag, errs } from '../../lib/openapi.js';
import { CREDENTIAL_BODY_LIMIT } from '../../lib/body-limits.js';
import { refuseWhileImpersonating } from '../../middleware/impersonation.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { AUTHENTICATED_ERRORS, IMPERSONATION_403, USER_SESSION_401, recordEndUserEvent } from './auth.routes.js';
import { EMAILED_CODE_PURPOSES, hasPasswordOrAuthenticator, sendEmailedCode } from './emailed-code.js';
import { RekeyError } from '../../lib/error.js';
import { assertFirstPasswordAllowed, setFirstPassword } from './first-password.js';
import { confirmEmailChange } from './email-change.js';

const EmailCodeBody = z.object({ purpose: z.enum(EMAILED_CODE_PURPOSES) });
const EmailChangeConfirmBody = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(256).optional(),
});
const SetPasswordBody = z.object({
  newPassword: z.string().min(1).max(256),
  emailCode: z.string().min(1).max(16),
});

export async function accountCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/email-code',
    {
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      // Sends an email on every call, like /send-verification; the
      // per-recipient auth email cap applies on top.
      config: { rateLimit: authRateLimit(5) },
      preHandler: refuseWhileImpersonating('ask for a code to change this account'),
      schema: {
        tags: ['Public · Auth'],
        summary: "Email a six-digit code to the current user's verified address",
        description:
          'Proves the caller can read the mailbox before an account change a session alone must not make: ' +
          '`set_password` for POST /auth/set-password, `delete_account` for DELETE /users/me. The code ' +
          'works once, for 10 minutes; five wrong tries end it; a new request replaces it. It is never returned ' +
          'in the response.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['purpose'],
          properties: { purpose: { type: 'string', enum: [...EMAILED_CODE_PURPOSES] } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                sent: { type: 'boolean', enum: [true] },
                expiresAt: { type: 'string', format: 'date-time' },
              },
              required: ['sent', 'expiresAt'],
            },
            'The code was emailed.',
          ),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            400: 'AUTH_METHOD_DISABLED: `set_password` asked while password sign-in is off for this Application.',
            403: `${IMPERSONATION_403} Or EMAIL_NOT_VERIFIED: the account's address is not confirmed, so a code sent to it proves nothing.`,
            409:
              'PASSWORD_ALREADY_SET: `set_password` asked for an account that already has a password; or ' +
              'EMAIL_CODE_NOT_ACCEPTED: `delete_account` asked for an account with a password or an authenticator, ' +
              'which confirms deletion with that. Nothing was sent.',
            429: `${AUTHENTICATED_ERRORS[429]} Or AUTH_EMAIL_RECIPIENT_CAPPED: this address has had the most auth emails allowed for now.`,
            503: 'EMAIL_CODE_NOT_SENT: the Application could not send the email; nothing was sent.',
          }),
        },
      },
    },
    async (req) => {
      const body = EmailCodeBody.parse(req.body);
      if (body.purpose === 'set_password') await assertFirstPasswordAllowed(req.application!, req.endUser!.id);
      if (body.purpose === 'delete_account' && (await hasPasswordOrAuthenticator(req.endUser!.id))) {
        throw new RekeyError({
          statusCode: 409,
          code: 'EMAIL_CODE_NOT_ACCEPTED',
          message: 'This account confirms its deletion with its password or authenticator, so no code was sent.',
          fix: 'Send `password`, or `code` from the authenticator, to DELETE /api/v1/users/me instead.',
        });
      }
      const result = await sendEmailedCode({
        application: req.application!,
        endUserId: req.endUser!.id,
        purpose: body.purpose,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/set-password',
    {
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      config: { rateLimit: authRateLimit(10) },
      preHandler: refuseWhileImpersonating('set a password on this account'),
      schema: {
        tags: ['Public · Auth'],
        summary: 'Set a first password on an account that has none',
        description:
          'For an account that joined by emailed link or a social provider. Needs `emailCode`, a code from ' +
          'POST /auth/email-code { "purpose": "set_password" }, from browser and server callers alike: a ' +
          'password outlives every session, so a session alone must not be able to set one. The same length ' +
          'and breach checks as sign-up apply. On success every session ends, this one included, as after a ' +
          'password change.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['newPassword', 'emailCode'],
          properties: {
            newPassword: { type: 'string', minLength: 1, maxLength: 256 },
            emailCode: { type: 'string', minLength: 1, maxLength: 16 },
          },
        },
        response: {
          200: okFlag('Password set; every session for this end-user was revoked.'),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            400:
              'AUTH_METHOD_DISABLED: password sign-in is off for this Application; or ' +
              'PASSWORD_TOO_SHORT: shorter than `authConfig.passwordMinLength`; or ' +
              'PASSWORD_BREACHED: the password appears in a known breach corpus.',
            401: `${USER_SESSION_401} Or EMAIL_CODE_INVALID: \`emailCode\` is wrong, used, expired or out of tries.`,
            403: IMPERSONATION_403,
            409: 'PASSWORD_ALREADY_SET: the account has a password; change or reset it instead.',
          }),
        },
      },
    },
    async (req) => {
      const body = SetPasswordBody.parse(req.body);
      const result = await setFirstPassword({
        application: req.application!,
        endUserId: req.endUser!.id,
        newPassword: body.newPassword,
        emailCode: body.emailCode,
      });
      recordEndUserEvent(req, 'user.password_set', req.endUser!.id);
      return { success: true, data: result };
    },
  );
}

/**
 * POST /email-change/confirm. Registered in the public `authRoutes` plugin:
 * the link may be opened where the account is not signed in, so a session is
 * optional and, without one, the current password is the proof.
 */
export async function emailChangeConfirmRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/email-change/confirm',
    {
      bodyLimit: CREDENTIAL_BODY_LIMIT,
      // Checks a password when no session comes with the link.
      config: { rateLimit: authRateLimit(10) },
      preHandler: async (req, reply) => {
        if (typeof req.headers['x-rekey-user-token'] !== 'string') return;
        await requireUserSession(req, reply);
        await refuseWhileImpersonating("change this account's email address")(req, reply);
      },
      schema: {
        tags: ['Public · Auth'],
        summary: 'Confirm an email address change with the emailed link',
        description:
          'Spends the `token` from the link POST /users/me/email mailed to the new address. Send it with ' +
          "the account's X-Rekey-User-Token, or with `password`, the account's current password. On success " +
          'the new address is the account\'s, verified; every session ends; unspent links mailed to the old ' +
          'address stop working. Linked sign-in providers, passkeys and two-factor stay.',
        security: [{ publishableKey: [] }, { apiKey: [] }, { publishableKey: [], userToken: [] }, { apiKey: [], userToken: [] }],
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 512 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { ok: { type: 'boolean', enum: [true] }, email: { type: 'string' } },
              required: ['ok', 'email'],
            },
            'The address changed and every session ended.',
          ),
          ...errs({
            ...AUTHENTICATED_ERRORS,
            401:
              `${USER_SESSION_401} Or EMAIL_CHANGE_TOKEN_INVALID: the link is unknown, used, expired or cancelled; ` +
              'or EMAIL_CHANGE_PROOF_REQUIRED: no session of the same account and no `password`; or ' +
              'INVALID_CREDENTIALS: `password` is not the account\'s current one.',
            403: `${IMPERSONATION_403} Or EMAIL_CHANGE_DOMAIN_NOT_ALLOWED: the application no longer accepts that address.`,
            409: 'EMAIL_ALREADY_EXISTS: another account in this application uses the new address.',
          }),
        },
      },
    },
    async (req) => {
      const body = EmailChangeConfirmBody.parse(req.body);
      const result = await confirmEmailChange({
        application: req.application!,
        token: body.token,
        ...(req.endUser && { sessionEndUserId: req.endUser.id }),
        ...(body.password !== undefined && { password: body.password }),
      });
      recordEndUserEvent(req, 'user.email_changed', result.endUserId);
      return { success: true, data: { ok: result.ok, email: result.email } };
    },
  );
}
