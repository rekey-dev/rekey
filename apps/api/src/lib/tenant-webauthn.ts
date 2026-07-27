/**
 * Operator-side WebAuthn / passkey ceremonies.
 *
 * The panel is a single relying party across all tenants (one domain),
 * so the RP config is read from env, not per-tenant. Mirrors the shape
 * of `lib/webauthn.ts` but parameterized by the tenant user rather than
 * an Application.
 */

import type { TenantUser, TenantWebAuthnCredential } from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type GenerateAuthenticationOptionsOpts,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { RekeyError } from './error.js';

export interface PanelRpConfig {
  rpId: string;
  rpOrigins: string[];
  rpName: string;
}

// Read from process.env directly (not via the frozen `env` proxy) because
// operators can toggle WebAuthn on a running server by setting env + reloading,
// and tests need to flip the config per-suite without restarting the app.
export function panelRpConfig(): PanelRpConfig {
  const rpId = process.env.PANEL_WEBAUTHN_RP_ID;
  const rpOriginsRaw = process.env.PANEL_WEBAUTHN_RP_ORIGINS;

  // Explicit config wins — full control over rpId + the accepted origins.
  if (rpId && rpOriginsRaw) {
    const rpOrigins = rpOriginsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (rpOrigins.length === 0) {
      throw new RekeyError({
        statusCode: 400,
        code: 'WEBAUTHN_NOT_CONFIGURED',
        message: 'PANEL_WEBAUTHN_RP_ORIGINS resolved to no valid origins.',
        fix: 'Set PANEL_WEBAUTHN_RP_ORIGINS to a comma-separated list of full origins, e.g. https://panel.example.com',
      });
    }
    return { rpId, rpOrigins, rpName: process.env.PANEL_WEBAUTHN_RP_NAME ?? rpId };
  }

  // Fallback: derive the relying party from the panel origin already declared
  // in CORS_ALLOWED_ORIGINS, so operator passkeys work out of the box without a
  // second WebAuthn-specific env. The panel origin is preferred by a `panel.`
  // hostname prefix, else the first origin; rpId is its hostname and the
  // accepted origins are the CORS entries sharing that host.
  const derived = deriveRpFromCors();
  if (derived) return derived;

  throw new RekeyError({
    statusCode: 400,
    code: 'WEBAUTHN_NOT_CONFIGURED',
    message:
      'Panel-side WebAuthn is not configured — operator passkey ceremonies cannot run.',
    fix: 'Set CORS_ALLOWED_ORIGINS to the panel origin (e.g. https://panel.example.com), or set PANEL_WEBAUTHN_RP_ID + PANEL_WEBAUTHN_RP_ORIGINS explicitly.',
  });
}

/**
 * Derive a PanelRpConfig from CORS_ALLOWED_ORIGINS. Returns null when no usable
 * https origin is present (caller then throws WEBAUTHN_NOT_CONFIGURED). Read
 * from process.env directly to match the explicit path's hot-reload semantics.
 */
function deriveRpFromCors(): PanelRpConfig | null {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return null;
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let chosen: URL | null = null;
  for (const o of origins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      continue;
    }
    // Prefer the conventional `panel.` host; otherwise keep the first valid one.
    if (u.hostname.startsWith('panel.')) {
      chosen = u;
      break;
    }
    if (!chosen) chosen = u;
  }
  if (!chosen) return null;

  const rpId = chosen.hostname;
  const rpOrigins = origins.filter((o) => {
    try {
      return new URL(o).hostname === rpId;
    } catch {
      return false;
    }
  });
  return {
    rpId,
    rpOrigins: rpOrigins.length > 0 ? rpOrigins : [chosen.origin],
    rpName: process.env.PANEL_WEBAUTHN_RP_NAME ?? 'Rekey Panel',
  };
}

export async function buildTenantRegistrationOptions(args: {
  tenantUser: Pick<TenantUser, 'id' | 'email'>;
  excludeCredentials: TenantWebAuthnCredential[];
}): Promise<{
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  expectedChallenge: string;
}> {
  const rp = panelRpConfig();
  const opts: GenerateRegistrationOptionsOpts = {
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new TextEncoder().encode(args.tenantUser.id),
    userName: args.tenantUser.email,
    attestationType: 'none',
    excludeCredentials: args.excludeCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  };
  const options = await generateRegistrationOptions(opts);
  return { options, expectedChallenge: options.challenge };
}

export async function verifyTenantRegistration(args: {
  response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  const rp = panelRpConfig();
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: rp.rpOrigins,
    expectedRPID: rp.rpId,
    requireUserVerification: false,
  });
}

export async function buildTenantAuthenticationOptions(args: {
  allowCredentials: TenantWebAuthnCredential[] | null;
}): Promise<{
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  expectedChallenge: string;
}> {
  const rp = panelRpConfig();
  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: rp.rpId,
    userVerification: 'preferred',
    ...(args.allowCredentials !== null && {
      allowCredentials: args.allowCredentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
    }),
  };
  const options = await generateAuthenticationOptions(opts);
  return { options, expectedChallenge: options.challenge };
}

export async function verifyTenantAuthentication(args: {
  response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
  expectedChallenge: string;
  credential: TenantWebAuthnCredential;
}): Promise<VerifiedAuthenticationResponse> {
  const rp = panelRpConfig();
  return verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: rp.rpOrigins,
    expectedRPID: rp.rpId,
    credential: {
      id: args.credential.credentialId,
      publicKey: Buffer.from(args.credential.publicKey, 'base64url'),
      counter: Number(args.credential.counter),
      transports: args.credential.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: false,
  });
}
