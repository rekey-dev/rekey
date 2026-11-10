'use server';

/**
 * Two-factor setup for a signed-in customer. These return their result to the
 * calling component instead of redirecting: the setup key and backup codes may
 * only travel in the response to the request that minted them, never in a URL.
 */

import QRCode from 'qrcode';
import { getAccessToken } from './session';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { twoFactorSetUpErrorCopy } from './auth-error-copy';
import { backupCodesErrorCopy } from './security-copy';
import { isSessionRefusal } from './devices';

export type TwoFactorSetUp = { otpauthUrl: string; setupKey: string; qrSvg: string | null; backupCodes: string[] };
export type TwoFactorStartResult = { ok: true; setUp: TwoFactorSetUp } | { ok: false; message: string };
export type TwoFactorConfirmResult = { ok: true } | { ok: false; message: string };
export type BackupCodesResult = { ok: true; backupCodes: string[] } | { ok: false; message: string };

async function signedIn(slug: string) {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  return config && accessToken ? { config, accessToken } : null;
}

export async function startTwoFactorSetUpAction(slug: string): Promise<TwoFactorStartResult> {
  const session = await signedIn(slug);
  if (!session) return { ok: false, message: twoFactorSetUpErrorCopy('SESSION_EXPIRED') };
  const result = await customerCall<{ otpauthUrl: string; backupCodes: string[] }>(
    session.config,
    session.accessToken,
    'POST',
    '/api/v1/auth/mfa/setup',
    {},
  );
  if (!result.ok) return { ok: false, message: twoFactorSetUpErrorCopy(result.code, result.retryAfterSeconds) };
  const { otpauthUrl, backupCodes } = result.data;
  const qrSvg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1, width: 192 }).catch(() => null);
  const setupKey = new URL(otpauthUrl).searchParams.get('secret') ?? '';
  return { ok: true, setUp: { otpauthUrl, setupKey, qrSvg, backupCodes } };
}

export async function confirmTwoFactorSetUpAction(slug: string, formData: FormData): Promise<TwoFactorConfirmResult> {
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!code) return { ok: false, message: twoFactorSetUpErrorCopy('missing') };
  const session = await signedIn(slug);
  if (!session) return { ok: false, message: twoFactorSetUpErrorCopy('SESSION_EXPIRED') };
  const result = await customerCall(session.config, session.accessToken, 'POST', '/api/v1/auth/mfa/setup-confirm', {
    code,
  });
  return result.ok ? { ok: true } : { ok: false, message: twoFactorSetUpErrorCopy(result.code, result.retryAfterSeconds) };
}

/** The new codes go back in this response only, so they reach no URL, cookie or log. */
export async function replaceBackupCodesAction(slug: string, formData: FormData): Promise<BackupCodesResult> {
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!code) return { ok: false, message: backupCodesErrorCopy('missing') };
  const session = await signedIn(slug);
  if (!session) return { ok: false, message: backupCodesErrorCopy('SESSION_EXPIRED') };
  const result = await customerCall<{ backupCodes: string[] }>(
    session.config,
    session.accessToken,
    'POST',
    '/api/v1/auth/mfa/backup-codes',
    { code },
  );
  return result.ok
    ? { ok: true, backupCodes: result.data.backupCodes }
    : {
        ok: false,
        message: backupCodesErrorCopy(isSessionRefusal(result.code) ? 'SESSION_EXPIRED' : result.code, result.retryAfterSeconds),
      };
}
