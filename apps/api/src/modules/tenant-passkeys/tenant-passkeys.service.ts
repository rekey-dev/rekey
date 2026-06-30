/**
 * Operator passkey service.
 *
 * Manages TenantWebAuthnCredential rows for tenant users. Two ceremonies:
 *
 *   - Registration (authenticated): add a passkey to the current operator.
 *   - Authentication (unauthenticated): sign in directly with a passkey,
 *     bypassing password + MFA (the passkey is itself a strong factor).
 *
 * Anti-replay is enforced server-side via the challenge store
 * (`lib/webauthn-challenge.ts`): `*Start` persists the challenge and
 * `*Complete` atomically consumes it (single-use, 5-minute TTL). The
 * `expectedChallenge` posted back is validated against that store, not
 * trusted verbatim — so a captured assertion can't be replayed.
 */

import type { TenantUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import {
  buildTenantRegistrationOptions,
  verifyTenantRegistration,
  buildTenantAuthenticationOptions,
  verifyTenantAuthentication,
} from '../../lib/tenant-webauthn.js';
import { storeChallenge, consumeChallenge } from '../../lib/webauthn-challenge.js';
import { issueTenantAccessToken } from '../../lib/tenant-jwt.js';
import { issueTenantRefreshToken } from '../../lib/tenant-refresh-tokens.js';
import type {
  AuthSessionResult,
  MembershipSummary,
  PublicTenantUser,
  TenantDeviceContext,
} from '../tenant-auth/tenant-auth.service.js';

export interface PasskeyRow {
  id: string;
  credentialId: string;
  deviceName: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function shape(c: {
  id: string;
  credentialId: string;
  deviceName: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): PasskeyRow {
  return {
    id: c.id,
    credentialId: c.credentialId,
    deviceName: c.deviceName,
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

function redact(user: TenantUser): PublicTenantUser {
  const { passwordHash: _pw, ...rest } = user;
  return rest;
}

async function loadMemberships(tenantUserId: string): Promise<MembershipSummary[]> {
  const rows = await prisma.tenantMembership.findMany({
    where: { tenantUserId },
    include: { tenant: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ tenantId: r.tenantId, tenantName: r.tenant.name, role: r.role }));
}

export const tenantPasskeysService = {
  async list(tenantUserId: string): Promise<PasskeyRow[]> {
    const rows = await prisma.tenantWebAuthnCredential.findMany({
      where: { tenantUserId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(shape);
  },

  async registerStart(tenantUserId: string): Promise<{
    options: Awaited<ReturnType<typeof buildTenantRegistrationOptions>>['options'];
    expectedChallenge: string;
  }> {
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: tenantUserId } });
    const existing = await prisma.tenantWebAuthnCredential.findMany({
      where: { tenantUserId: user.id },
    });
    const result = await buildTenantRegistrationOptions({
      tenantUser: { id: user.id, email: user.email },
      excludeCredentials: existing,
    });
    await storeChallenge({
      challenge: result.expectedChallenge,
      ceremony: 'registration',
      scope: 'tenant',
      subjectId: user.id,
    });
    return result;
  },

  async registerComplete(args: {
    tenantUserId: string;
    expectedChallenge: string;
    response: Parameters<typeof verifyTenantRegistration>[0]['response'];
    deviceName?: string;
  }): Promise<PasskeyRow> {
    // Burn the challenge first (single-use, bound to this operator) so a
    // captured registration response can't be replayed.
    await consumeChallenge({
      challenge: args.expectedChallenge,
      ceremony: 'registration',
      scope: 'tenant',
      expectedSubjectId: args.tenantUserId,
    });
    const verified = await verifyTenantRegistration({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
    });
    if (!verified.verified || !verified.registrationInfo) {
      throw new RelipayError({
        statusCode: 400,
        code: 'PASSKEY_REGISTRATION_FAILED',
        message: 'Passkey registration ceremony did not verify.',
        fix: 'Retry the registration; cancel any in-flight authenticator prompts first.',
      });
    }
    const info = verified.registrationInfo;
    const credentialId = info.credential.id;
    const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');
    const counter = info.credential.counter;
    const transports = (args.response as { response?: { transports?: string[] } }).response
      ?.transports;

    const dupe = await prisma.tenantWebAuthnCredential.findUnique({
      where: { credentialId },
    });
    if (dupe) {
      throw new RelipayError({
        statusCode: 409,
        code: 'PASSKEY_ALREADY_REGISTERED',
        message: 'This authenticator is already registered.',
        fix: 'Use a different authenticator, or delete the existing credential first.',
      });
    }

    const created = await prisma.tenantWebAuthnCredential.create({
      data: {
        tenantUserId: args.tenantUserId,
        credentialId,
        publicKey,
        counter: BigInt(counter),
        transports: transports ?? [],
        ...(args.deviceName !== undefined && { deviceName: args.deviceName }),
      },
    });
    return shape(created);
  },

  async authenticateStart(): Promise<{
    options: Awaited<ReturnType<typeof buildTenantAuthenticationOptions>>['options'];
    expectedChallenge: string;
  }> {
    // Usernameless ceremony — operator picks the resident-key passkey on
    // their device. We don't expose an email-first variant here because
    // any pre-population would leak account existence to the browser.
    const result = await buildTenantAuthenticationOptions({ allowCredentials: null });
    await storeChallenge({
      challenge: result.expectedChallenge,
      ceremony: 'authentication',
      scope: 'tenant',
    });
    return result;
  },

  async authenticateComplete(args: {
    expectedChallenge: string;
    response: Parameters<typeof verifyTenantAuthentication>[0]['response'];
    device?: TenantDeviceContext;
  }): Promise<AuthSessionResult> {
    const credentialId = (args.response as { id?: string }).id;
    if (!credentialId) {
      throw new RelipayError({
        statusCode: 400,
        code: 'PASSKEY_RESPONSE_INVALID',
        message: 'Passkey response is missing a credential id.',
        fix: 'Resend the full authenticator response object as returned by `navigator.credentials.get(...)`.',
      });
    }
    // Burn the challenge first (single-use) so a captured assertion can't be
    // replayed into a session — this is the anti-replay control, since the
    // counter check is a no-op for synced platform passkeys (counter = 0).
    await consumeChallenge({
      challenge: args.expectedChallenge,
      ceremony: 'authentication',
      scope: 'tenant',
    });
    const credential = await prisma.tenantWebAuthnCredential.findUnique({
      where: { credentialId },
    });
    if (!credential) {
      throw new RelipayError({
        statusCode: 401,
        code: 'PASSKEY_UNKNOWN',
        message: 'No operator account matches that passkey.',
        fix: 'Register the passkey via the panel first (Account → Passkeys).',
      });
    }
    const verified = await verifyTenantAuthentication({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      credential,
    });
    if (!verified.verified) {
      throw new RelipayError({
        statusCode: 401,
        code: 'PASSKEY_AUTHENTICATION_FAILED',
        message: 'Passkey authentication did not verify.',
        fix: 'Retry; cancel any in-flight authenticator prompts first.',
      });
    }
    await prisma.tenantWebAuthnCredential.update({
      where: { id: credential.id },
      data: {
        counter: BigInt(verified.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });

    const user = await prisma.tenantUser.findUniqueOrThrow({
      where: { id: credential.tenantUserId },
    });
    const memberships = await loadMemberships(user.id);
    if (memberships.length === 0) {
      throw new RelipayError({
        statusCode: 403,
        code: 'NO_TENANT_MEMBERSHIPS',
        message: 'Your account is not a member of any workspace.',
        fix: 'Ask an existing workspace owner for a fresh invitation.',
      });
    }
    const active = memberships[0]!;
    const access = issueTenantAccessToken(user.id, active.tenantId, active.role);
    const refresh = await issueTenantRefreshToken(user.id, {
      userAgent: args.device?.userAgent ?? null,
      ip: args.device?.ip ?? null,
    });
    return {
      user: redact(user),
      memberships,
      activeTenantId: active.tenantId,
      activeRole: active.role,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt: refresh.record.expiresAt,
    };
  },

  async delete(args: { tenantUserId: string; passkeyId: string }): Promise<void> {
    const cred = await prisma.tenantWebAuthnCredential.findUnique({
      where: { id: args.passkeyId },
    });
    if (!cred || cred.tenantUserId !== args.tenantUserId) {
      throw new RelipayError({
        statusCode: 404,
        code: 'PASSKEY_NOT_FOUND',
        message: 'That passkey is not registered to this account.',
        fix: 'List passkeys via GET /tenant/auth/passkeys to confirm the id.',
      });
    }
    await prisma.tenantWebAuthnCredential.delete({ where: { id: cred.id } });
  },
};

