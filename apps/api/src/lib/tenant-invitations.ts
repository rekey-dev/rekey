/**
 * Workspace invitation token helpers.
 *
 * Per the user's call: invitations are unique-per-recipient single-use
 * links with an expiry — not domain-restricted "anyone can join" links.
 * 7-day lifetime by default. Hash-only DB.
 *
 * The owner generates an invite, gets back a one-time-show raw token, and
 * shares the URL `/accept-invite?token=…` with the recipient via whatever
 * channel they like (email, Slack, text). The recipient signs in (or signs
 * up) and POSTs the token to /tenant/invitations/accept.
 */

import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashInvitationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function defaultInvitationExpiry(): Date {
  return new Date(Date.now() + DEFAULT_LIFETIME_MS);
}
