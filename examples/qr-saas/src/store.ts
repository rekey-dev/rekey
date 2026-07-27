/**
 * The QR app's OWN data store. This is deliberately NOT in Rekey — Rekey
 * owns auth + billing + usage + entitlements; the QR codes themselves are our
 * product data. A tiny JSON-file-backed store keeps the sample runnable with
 * zero infra (swap for Postgres/sqlite in a real app).
 *
 * A "dynamic" QR encodes a stable short URL (/q/:slug); only `destination` is
 * mutable, so the printed code never changes but where it points does.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface QrCode {
  id: string;
  slug: string;
  destination: string;
  /** Rekey subject this QR belongs to: an end-user id, or an org id. */
  ownerEndUserId: string;
  /** Set when the QR belongs to a team workspace (Rekey organization). */
  organizationId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface Db {
  qrs: QrCode[];
}

const DATA_PATH = process.env.QR_DATA_PATH ?? join(process.cwd(), '.data', 'qr-store.json');

function load(): Db {
  if (!existsSync(DATA_PATH)) return { qrs: [] };
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Db;
  } catch {
    return { qrs: [] };
  }
}

function persist(db: Db): void {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
}

let db: Db = load();

function id(): string {
  return 'qr_' + randomBytes(9).toString('hex');
}

/** URL-safe slug generator for the public short link. */
export function freshSlug(): string {
  return randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 7) || 'q' + Date.now();
}

/** Scope: a personal owner, or an org workspace. */
export type Scope = { ownerEndUserId: string; organizationId: string | null };

export const store = {
  /** All QRs visible in a scope (org workspace, or the user's personal set). */
  list(scope: Scope): QrCode[] {
    if (scope.organizationId) return db.qrs.filter((q) => q.organizationId === scope.organizationId);
    return db.qrs.filter((q) => q.ownerEndUserId === scope.ownerEndUserId && q.organizationId === null);
  },

  /** Count of dynamic QRs in a scope — used to enforce the per-tier QR cap. */
  count(scope: Scope): number {
    return this.list(scope).length;
  },

  create(input: { slug: string; destination: string; title: string } & Scope): QrCode {
    const now = new Date().toISOString();
    const qr: QrCode = {
      id: id(),
      slug: input.slug,
      destination: input.destination,
      title: input.title,
      ownerEndUserId: input.ownerEndUserId,
      organizationId: input.organizationId,
      createdAt: now,
      updatedAt: now,
    };
    db.qrs.push(qr);
    persist(db);
    return qr;
  },

  bySlug(slug: string): QrCode | undefined {
    return db.qrs.find((q) => q.slug === slug);
  },

  byId(qrId: string): QrCode | undefined {
    return db.qrs.find((q) => q.id === qrId);
  },

  slugTaken(slug: string): boolean {
    return db.qrs.some((q) => q.slug === slug);
  },

  updateDestination(qrId: string, destination: string): QrCode | undefined {
    const qr = this.byId(qrId);
    if (!qr) return undefined;
    qr.destination = destination;
    qr.updatedAt = new Date().toISOString();
    persist(db);
    return qr;
  },

  remove(qrId: string): boolean {
    const before = db.qrs.length;
    db.qrs = db.qrs.filter((q) => q.id !== qrId);
    if (db.qrs.length !== before) {
      persist(db);
      return true;
    }
    return false;
  },

  /** Test helper — wipe the store. */
  _reset(): void {
    db = { qrs: [] };
    persist(db);
  },
};
