/**
 * End-user IP addresses on operator and secret-key surfaces.
 *
 * An IP address is personal data. OWNER and ADMIN operators whose credential
 * holds `activity:read` see it in full, as the security-events log already
 * requires; everyone else gets the network only: IPv4 to /24, IPv6 to /48.
 * A secret key reads what its minter could read when it was minted
 * (`ApiKey.revealsEndUserIps`); a key minted before that was recorded keeps
 * reading addresses in full.
 */

import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { Address6 } from 'ip-address';
import { accessContextFromRequest, isWorkspaceAdmin } from './access-context.js';
import type { Scope } from './operator-scopes.js';

/**
 * The /24 (IPv4) or /48 (IPv6) network of an address, in canonical CIDR form.
 * An IPv4-mapped IPv6 address is masked as IPv4. Anything unparseable is null.
 *
 * @example
 *   maskIp('203.0.113.77') // '203.0.113.0/24'
 *   maskIp('2001:db8:1234:5678::1') // '2001:db8:1234::/48'
 *   maskIp('::1') // '::/48'
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const value = ip.trim().toLowerCase();
  const mapped = value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : null;
  const v4 = mapped ?? (isIP(value) === 4 ? value : null);
  if (v4) {
    const [a, b, c] = v4.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIP(value) !== 6) return null;
  return `${new Address6(`${value}/48`).startAddress().correctForm()}/48`;
}

/**
 * OWNER or ADMIN whose credential holds `activity:read`. `scopes` must be the
 * credential's own set (a PAT or MCP token narrows it), not the role's
 * effective set, which is unrestricted for a workspace admin.
 */
export function mayReadRawIps(role: string, scopes: ReadonlySet<Scope>): boolean {
  return isWorkspaceAdmin(role as Parameters<typeof isWorkspaceAdmin>[0]) && scopes.has('activity:read');
}

export type IpProjection = (ip: string | null | undefined) => string | null;

const raw: IpProjection = (ip) => ip ?? null;

/**
 * The projection for an operator request (panel session or PAT).
 *
 * @example
 *   const ip = await operatorIpProjection(req);
 *   rows.map((r) => ({ ...r, ip: ip(r.ip) }));
 */
export async function operatorIpProjection(req: FastifyRequest): Promise<IpProjection> {
  const ctx = await accessContextFromRequest(req);
  return mayReadRawIps(ctx.role, ctx.scopes) ? raw : maskIp;
}

/**
 * The projection for a secret-key request: what the key's minter could read.
 *
 * @example
 *   const ip = keyIpProjection(req.apiKey);
 */
export function keyIpProjection(key: { revealsEndUserIps: boolean | null } | undefined): IpProjection {
  return key?.revealsEndUserIps === false ? maskIp : raw;
}
