/**
 * WebAuthn / passkey ceremony wrappers.
 *
 * Thin layer over `@simplewebauthn/server` that:
 *
 *   - Loads the Application's RP config (rpId, rpOrigins, rpName) from
 *     `authConfig.webauthn`, with deliberate failure if absent. The two
 *     ceremonies refuse to mint options when the Application hasn't been
 *     configured — registering a passkey to a guess-able rpId is
 *     security-relevant, so we don't fall back to anything.
 *
 *   - Generates the ceremony challenge. Anti-replay is enforced by the
 *     server-side challenge store (`lib/webauthn-challenge.ts`): the
 *     `start` path persists the challenge, the `complete` path atomically
 *     consumes it (single-use, 5-minute TTL). The posted `expectedChallenge`
 *     is validated against that store, never trusted on its own — a replayed
 *     assertion fails because its challenge was already burned.
 *
 * SimpleWebAuthn handles the cryptographic verification (signature,
 * counter advancement, attestation parsing). We persist `counter` after
 * every successful authentication so cloned-authenticator detection
 * works across sessions.
 */

import type { Application, WebAuthnCredential } from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type GenerateAuthenticationOptionsOpts,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { AuthConfigSchema } from '@relipay/shared-types';
import { RelipayError } from './error.js';

export interface RpConfig {
  rpId: string;
  rpOrigins: string[];
  rpName: string;
}

/**
 * Resolve the RP config from `authConfig.webauthn`. Throws if not
 * configured — callers should not paper over this with defaults; the
 * Application owner must opt into WebAuthn explicitly.
 */
export function rpConfigForApplication(application: Application): RpConfig {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.webauthn) {
    throw new RelipayError({
      statusCode: 400,
      code: 'WEBAUTHN_NOT_CONFIGURED',
      message:
        'This Application has no WebAuthn config — passkey ceremonies cannot run.',
      fix: 'Set `authConfig.webauthn = { rpId, rpOrigins }` on the Application (Panel → Application → Auth).',
    });
  }
  return {
    rpId: config.webauthn.rpId,
    rpOrigins: config.webauthn.rpOrigins,
    rpName: config.webauthn.rpName ?? config.webauthn.rpId,
  };
}

/**
 * Wrap SimpleWebAuthn's registration-options generator. Caller passes the
 * EndUser identifier (we use `endUserId` as the WebAuthn user handle —
 * stable across email changes, never exposed to the user) and the
 * `excludeCredentials` list (credentials already registered for this
 * user, so the authenticator refuses to register a duplicate).
 */
export async function buildRegistrationOptions(args: {
  application: Application;
  endUserId: string;
  userEmail: string;
  excludeCredentials: WebAuthnCredential[];
}): Promise<{ options: Awaited<ReturnType<typeof generateRegistrationOptions>>; expectedChallenge: string }> {
  const rp = rpConfigForApplication(args.application);
  const opts: GenerateRegistrationOptionsOpts = {
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new TextEncoder().encode(args.endUserId),
    userName: args.userEmail,
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

export async function verifyRegistration(args: {
  application: Application;
  response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  const rp = rpConfigForApplication(args.application);
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: rp.rpOrigins,
    expectedRPID: rp.rpId,
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(args: {
  application: Application;
  /**
   * Allow-list to send to the browser. When `null`, we run a usernameless
   * ceremony — works for resident-key passkeys and is the better UX when
   * the user hasn't typed an email. When non-null (email-first flow), we
   * scope to that user's credentials so the wrong-credential-for-email
   * UX fails fast.
   */
  allowCredentials: WebAuthnCredential[] | null;
}): Promise<{ options: Awaited<ReturnType<typeof generateAuthenticationOptions>>; expectedChallenge: string }> {
  const rp = rpConfigForApplication(args.application);
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

export async function verifyAuthentication(args: {
  application: Application;
  response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
  expectedChallenge: string;
  credential: WebAuthnCredential;
}): Promise<VerifiedAuthenticationResponse> {
  const rp = rpConfigForApplication(args.application);
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
