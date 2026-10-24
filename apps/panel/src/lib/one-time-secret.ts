/**
 * What a Server Action that mints a one-time secret returns, for
 * `RevealActionForm` to show. Plain types in their own module so a `'use server'`
 * file can name them without importing a client component.
 */

export interface OneTimeSecret {
  /** Dialog heading, e.g. "Your new API key". */
  title: string;
  /** The secret itself. */
  value: string;
  /** Short plain-text lines under the secret: how to use it, what else happened. */
  notes?: string[];
  /**
   * Analytics flag, as in `FLAG_EVENTS`. A mint used to report itself through
   * its success redirect's `?e=`; with no redirect, the dialog reports it.
   */
  flag?: string;
  /**
   * The operator can get a fresh one later (an invitation link they can send
   * again), so the dialog drops the "shown once" warning and closes freely.
   */
  reissuable?: boolean;
}

/** What a minting action resolves to. Nothing, when it redirected instead. */
export type RevealResult = { secret: OneTimeSecret } | undefined;
