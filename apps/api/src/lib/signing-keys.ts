/**
 * RS256 signing-key management for end-user access tokens (JWKS).
 *
 * Applications opt in per-app via `authConfig.tokenAlg = "RS256"` — their
 * access tokens are then signed with the deployment's ACTIVE RSA key (`kid`
 * in the JWT header) instead of the per-app derived HS256 secret, so
 * customers can verify sessions offline against `GET /.well-known/jwks.json`
 * (API gateways, edge middleware, `verifyAccessToken` in @rekey.dev/node).
 *
 * Key resolution, in priority order:
 *   1. env `JWT_RS256_PRIVATE_KEY` (PEM) — BYO key; nothing persisted. It is
 *      always the active signer when set. DB keys (if any) remain published
 *      in the JWKS so older tokens keep verifying.
 *   2. The newest `signing_keys` row with `rotatedAt = null`.
 *   3. None yet → generate a 2048-bit keypair on first use and persist it
 *      (private half AES-256-GCM encrypted via lib/secrets.ts).
 *
 * Rotation story (N keys, one active): insert a new row, stamp `rotatedAt`
 * on the old one. Rotated keys stop SIGNING immediately but stay in the JWKS
 * + the verification kid-map until deleted, so outstanding (≤15 min) access
 * tokens keep verifying. There is deliberately no "remove from JWKS" timer —
 * delete the row once its tokens are safely past expiry.
 *
 * `kid` is the RFC 7638 JWK thumbprint of the public key — deterministic, so
 * the same key material always maps to the same kid (idempotent boot, safe
 * concurrent first-boot generation across replicas: the loser of the unique
 * race re-reads the winner's row).
 */

import {
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';
import { encryptJson, decryptJson } from './secrets.js';
import type { JwkRsaPublic } from '@rekey.dev/shared-types';

export interface ActiveSigningKey {
  kid: string;
  alg: 'RS256';
  privatePem: string;
  publicPem: string;
}

// ---------------------------------------------------------------------------
// PEM / JWK helpers
// ---------------------------------------------------------------------------

/** Env vars often carry PEMs with literal `\n` — normalize before parsing. */
function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function publicJwkFromKey(key: KeyObject): { kty: 'RSA'; n: string; e: string } {
  const jwk = key.export({ format: 'jwk' }) as { kty?: string; n?: string; e?: string };
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error('JWT_RS256 signing key is not an RSA key.');
  }
  return { kty: 'RSA', n: jwk.n, e: jwk.e };
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) — the JWT header `kid`. */
function computeKid(publicKey: KeyObject): string {
  const { e, kty, n } = publicJwkFromKey(publicKey);
  // Canonical form: required members only, lexicographic order, no whitespace.
  const canonical = JSON.stringify({ e, kty, n });
  return createHash('sha256').update(canonical).digest('base64url');
}

function toJwk(kid: string, publicPem: string): JwkRsaPublic {
  const { n, e } = publicJwkFromKey(createPublicKey(publicPem));
  return { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n, e };
}

function keyFromPrivatePem(privatePem: string): ActiveSigningKey {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { kid: computeKid(publicKey), alg: 'RS256', privatePem, publicPem };
}

// ---------------------------------------------------------------------------
// Cache — small TTL so a rotation done by another replica is picked up
// without a restart. Env-key material never changes within a process, so it
// is resolved once and reused.
// ---------------------------------------------------------------------------

interface KeyCache {
  active: ActiveSigningKey;
  /** kid → public PEM, across ALL known keys (env + DB, rotated included). */
  publicByKid: Map<string, string>;
  /** JWKS entries in serving order (active first, then newest-first). */
  jwks: JwkRsaPublic[];
  loadedAt: number;
}

let cache: KeyCache | null = null;
let envKey: ActiveSigningKey | null | undefined; // undefined = not resolved yet
const TTL_MS = 60_000;

/** Test hook — drop the in-memory snapshot so the next call re-reads the DB. */
export function _clearSigningKeyCacheForTests(): void {
  cache = null;
  envKey = undefined;
}

function resolveEnvKey(): ActiveSigningKey | null {
  if (envKey !== undefined) return envKey;
  envKey = env.JWT_RS256_PRIVATE_KEY
    ? keyFromPrivatePem(normalizePem(env.JWT_RS256_PRIVATE_KEY))
    : null;
  return envKey;
}

/**
 * Generate + persist the first DB signing key. Concurrency-safe: `kid` is a
 * deterministic thumbprint with a unique constraint, and a parallel first-boot
 * on another replica that wins the insert race simply becomes the key we read
 * back on retry (each replica generates distinct material, so the unique
 * violation only fires for re-runs of the SAME key; the plain re-read covers
 * the distinct-material race because newest-wins selection is stable).
 */
async function generateAndPersistKey(): Promise<void> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = keyFromPrivatePem(privatePem);
  try {
    await prisma.signingKey.create({
      data: {
        kid: key.kid,
        alg: 'RS256',
        privatePemCiphertext: encryptJson({ privatePem: key.privatePem }),
        publicPem: key.publicPem,
      },
    });
  } catch (e) {
    // Unique violation on kid — another process persisted first. Fall through;
    // the caller re-reads and adopts whatever row won.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }
}

async function load(): Promise<KeyCache> {
  const fromEnv = resolveEnvKey();

  let rows = await prisma.signingKey.findMany({ orderBy: { createdAt: 'desc' } });
  if (!fromEnv && rows.length === 0) {
    await generateAndPersistKey();
    rows = await prisma.signingKey.findMany({ orderBy: { createdAt: 'desc' } });
  }

  const dbActive = rows.find((r) => r.rotatedAt === null) ?? null;
  let active: ActiveSigningKey;
  if (fromEnv) {
    active = fromEnv;
  } else if (dbActive) {
    const { privatePem } = decryptJson<{ privatePem: string }>(dbActive.privatePemCiphertext);
    active = { kid: dbActive.kid, alg: 'RS256', privatePem, publicPem: dbActive.publicPem };
  } else {
    // Rows exist but every one is rotated out and no env key — refuse rather
    // than silently signing with a retired key.
    throw new Error(
      'No active RS256 signing key: all signing_keys rows are rotated and JWT_RS256_PRIVATE_KEY is unset.',
    );
  }

  const publicByKid = new Map<string, string>();
  publicByKid.set(active.kid, active.publicPem);
  for (const row of rows) {
    if (!publicByKid.has(row.kid)) publicByKid.set(row.kid, row.publicPem);
  }

  const jwks = [...publicByKid.entries()].map(([kid, pem]) => toJwk(kid, pem));
  const snapshot: KeyCache = { active, publicByKid, jwks, loadedAt: Date.now() };
  cache = snapshot;
  return snapshot;
}

async function snapshot(): Promise<KeyCache> {
  if (cache && Date.now() - cache.loadedAt <= TTL_MS) return cache;
  return load();
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The key new RS256 tokens are signed with. Generates + persists a keypair on
 * first call when neither env key nor DB row exists.
 */
export async function getActiveSigningKey(): Promise<ActiveSigningKey> {
  return (await snapshot()).active;
}

/** Full JWKS body for `GET /.well-known/jwks.json` (active + rotated keys). */
export async function getJwks(): Promise<{ keys: JwkRsaPublic[] }> {
  return { keys: (await snapshot()).jwks };
}

/**
 * Public PEM for a presented `kid`, or null for unknown kids. STRICT — the
 * RS256 verification path only ever trusts keys returned here. A cache miss
 * triggers one forced reload (a freshly minted key on another replica) before
 * answering null.
 */
export async function getPublicKeyByKid(kid: string): Promise<string | null> {
  const snap = await snapshot();
  const hit = snap.publicByKid.get(kid);
  if (hit) return hit;
  if (Date.now() - snap.loadedAt > 1_000) {
    const fresh = await load();
    return fresh.publicByKid.get(kid) ?? null;
  }
  return null;
}

/**
 * Boot warm-up: resolve (or first-generate) the active key so the first
 * RS256 sign/verify doesn't pay keygen latency. Failure is non-fatal — apps
 * that never opt into RS256 must not be blocked by it (e.g. DB briefly
 * unavailable at boot; the lazy path retries on first use).
 */
export async function primeSigningKeys(): Promise<void> {
  await snapshot();
}
