'use server';

import { revalidatePath } from 'next/cache';
import { adminPost, adminDelete, AdminApiError, type MintedOperatorInvite, type OperatorInviteRow } from '@/lib/api';

const PATH = '/operator-invites';

export interface MintState {
  ok: boolean;
  /** Raw key — present exactly once, right after a successful mint. */
  rawToken?: string;
  tokenPrefix?: string;
  error?: string;
}

/**
 * Mint a new single-use operator-invite key. The raw key is returned to the
 * client component to display ONCE (it is unrecoverable afterwards) — it is
 * never persisted in the page or the URL.
 */
export async function mintInvite(_prev: MintState, formData: FormData): Promise<MintState> {
  const note = String(formData.get('note') ?? '').trim();
  const expiresInDays = Number(formData.get('expiresInDays') ?? 0);

  const body: { note?: string; expiresAt?: string } = {};
  if (note) body.note = note.slice(0, 200);
  if (Number.isFinite(expiresInDays) && expiresInDays > 0) {
    body.expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  try {
    const data = await adminPost<MintedOperatorInvite>('/api/v1/admin/operator-invites', body);
    revalidatePath(PATH);
    return { ok: true, rawToken: data.rawToken, tokenPrefix: data.invite.tokenPrefix };
  } catch (err) {
    const msg = err instanceof AdminApiError ? err.message : 'Could not mint an invite key.';
    return { ok: false, error: msg };
  }
}

/** Revoke an unused invite key. */
export async function revokeInvite(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return;
  try {
    await adminDelete<OperatorInviteRow>(`/api/v1/admin/operator-invites/${encodeURIComponent(id)}`);
  } catch {
    // Best-effort — a failed revoke (e.g. already used) leaves the row as-is;
    // the refreshed list shows the current state.
  }
  revalidatePath(PATH);
}
