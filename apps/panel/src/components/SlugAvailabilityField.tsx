'use client';

/**
 * Slug input with live availability feedback, derived from the name field.
 *
 * ## What was wrong
 *
 * Typing "Northwind Store" left Slug empty. The submit button was then
 * *disabled* — by this component reaching into `form.elements`, flipping
 * `btn.disabled`, and adding `opacity-50` — with nothing on screen saying which
 * field was blocking it. A dead button and no error message is the worst of
 * both: no feedback, and no way to ask for feedback. Worse, `status === 'checking'`
 * was in the same blocked set, so a click during the 350ms debounce plus the
 * round trip hit a disabled button and did nothing at all, with no indication
 * the click had even been received.
 *
 * ## What it does now
 *
 * - **Prefills** a slugified name, and keeps tracking the name until the
 *   operator edits the slug themselves. Clearing the slug restores the link, so
 *   an accidental edit isn't a one-way door.
 * - **Never disables the submit.** Submission is intercepted instead: if the
 *   slug is empty or known-bad the submit is cancelled, the field is focused,
 *   and a message names it. That is something an operator can act on.
 * - **A click during "Checking availability…" is held**, not dropped. It fires
 *   by itself the moment the check comes back clean, and the wait is stated.
 */

import * as React from 'react';

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error';

// Two spellings of one pattern, and they must keep accepting the same strings.
// The hyphen is escaped in SLUG_PATTERN because that string becomes the HTML
// `pattern` attribute, which the browser compiles with the `v` flag: a bare `-`
// after a range is an invalid character class there, and an invalid pattern is
// DISCARDED, which silently removes client-side validation. SLUG_RE is a plain
// literal with no `v` flag, where the bare hyphen is legal. Do not "tidy" one to
// match the other, and do not build the attribute with new RegExp(_, 'v').
const SLUG_PATTERN = '^[a-z0-9](?:[a-z0-9\\-]{0,38}[a-z0-9])?$';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DEBOUNCE_MS = 350;
const STATUS_ID = 'slug-availability-status';
const BLOCK_ID = 'slug-blocking-message';

const TAKEN_MSG = (v: string): string =>
  `“${v}” is already taken — slugs are globally unique. Pick another.`;
const INVALID_MSG =
  'The slug must be lowercase letters, digits and hyphens, 2–40 characters, starting and ending alphanumeric.';

/**
 * Name → slug. Lowercase, strip diacritics, runs of non-alphanumerics become a
 * single hyphen, trim to the API's 40-character ceiling, and never leave a
 * leading or trailing hyphen (the pattern requires alphanumeric edges).
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function SlugAvailabilityField({
  name = 'slug',
  placeholder,
  inputClassName,
  submitName,
  deriveFrom = 'name',
}: {
  name?: string;
  placeholder?: string;
  inputClassName?: string;
  /**
   * `name` attribute of the submit button, if there's more than one
   * form-control with `type="submit"`. Defaults to the first one in
   * `form.elements` matching `type="submit"`.
   */
  submitName?: string;
  /** `name` attribute of the text input to derive the slug from. */
  deriveFrom?: string;
}): React.JSX.Element {
  const [value, setValue] = React.useState('');
  const [status, setStatus] = React.useState<Status>('idle');
  /** True once the operator edits the slug directly — stops mirroring the name. */
  const [touched, setTouched] = React.useState(false);
  /** Non-null when a submit was attempted and blocked; names the reason. */
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null);
  /** A submit is waiting for the in-flight availability check to land. */
  const [submitPending, setSubmitPending] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const seqRef = React.useRef(0);
  const submitPendingRef = React.useRef(false);
  submitPendingRef.current = submitPending;

  const findSubmit = React.useCallback((): HTMLButtonElement | null => {
    const form = inputRef.current?.form;
    if (!form) return null;
    if (submitName) {
      const el = form.elements.namedItem(submitName);
      if (el instanceof HTMLButtonElement) return el;
    }
    for (const el of Array.from(form.elements)) {
      if (el instanceof HTMLButtonElement && el.type === 'submit') return el;
    }
    return null;
  }, [submitName]);

  // ── Mirror the name field until the slug is touched ──
  React.useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const source = form.elements.namedItem(deriveFrom);
    if (!(source instanceof HTMLInputElement)) return;

    const sync = (): void => {
      if (touched) return;
      setValue(slugify(source.value));
      setBlockedReason(null);
    };
    source.addEventListener('input', sync);
    // Catch a value restored by the browser (back/forward, autofill) that
    // never fires `input`.
    sync();
    return () => source.removeEventListener('input', sync);
  }, [deriveFrom, touched]);

  // ── Availability check ──
  React.useEffect(() => {
    if (value.length === 0) {
      setStatus('idle');
      return;
    }
    if (!SLUG_RE.test(value)) {
      setStatus('invalid');
      return;
    }
    setStatus('checking');
    const seq = ++seqRef.current;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/check-slug?slug=${encodeURIComponent(value)}`);
        const json = (await res.json()) as { available?: boolean; reason?: string };
        if (seq !== seqRef.current) return;
        if (json.available) setStatus('available');
        else if (json.reason === 'invalid') setStatus('invalid');
        else if (json.reason === 'taken') setStatus('taken');
        else setStatus('error');
      } catch {
        if (seq === seqRef.current) setStatus('error');
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [value]);

  // ── Release a submit that was held for the check ──
  React.useEffect(() => {
    if (!submitPending || status === 'checking') return;
    setSubmitPending(false);
    if (status === 'taken' || status === 'invalid') {
      setBlockedReason(status === 'taken' ? TAKEN_MSG(value) : INVALID_MSG);
      inputRef.current?.focus();
      return;
    }
    // 'available', 'idle' or 'error' (server unreachable — the server-side
    // action revalidates anyway, so don't strand the operator here).
    findSubmit()?.click();
  }, [submitPending, status, value, findSubmit]);

  // ── Intercept submit instead of disabling the button ──
  React.useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;

    const onSubmit = (e: SubmitEvent): void => {
      // Our own programmatic re-submit — let it through.
      if (submitPendingRef.current) return;
      const current = inputRef.current?.value ?? '';

      if (current.trim() === '') {
        e.preventDefault();
        setBlockedReason('A slug is required. It becomes part of your API keys and webhook URLs.');
        inputRef.current?.focus();
        return;
      }
      if (status === 'taken' || status === 'invalid') {
        e.preventDefault();
        setBlockedReason(status === 'taken' ? TAKEN_MSG(current) : INVALID_MSG);
        inputRef.current?.focus();
        return;
      }
      if (status === 'checking') {
        // Don't drop the click — hold it and fire when the answer arrives.
        e.preventDefault();
        setBlockedReason(null);
        setSubmitPending(true);
        return;
      }
      setBlockedReason(null);
    };

    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, [status]);

  const invalid = status === 'taken' || status === 'invalid';

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        name={name}
        autoComplete="off"
        spellCheck={false}
        pattern={SLUG_PATTERN}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const next = e.currentTarget.value.trim().toLowerCase();
          setValue(next);
          setBlockedReason(null);
          // Clearing the field re-links it to the name.
          setTouched(next !== '');
        }}
        className={inputClassName}
        aria-invalid={invalid || undefined}
        aria-describedby={blockedReason ? `${STATUS_ID} ${BLOCK_ID}` : STATUS_ID}
      />
      <SlugStatus status={status} value={value} derived={!touched && value !== ''} />
      {blockedReason && (
        <span id={BLOCK_ID} role="alert" className="block text-xs text-red-600 dark:text-red-400">
          {blockedReason}
        </span>
      )}
      {submitPending && (
        <span role="status" aria-live="polite" className="block text-xs text-[var(--color-muted-fg)]">
          Checking the slug, then creating…
        </span>
      )}
    </>
  );
}

function SlugStatus({
  status,
  value,
  derived,
}: {
  status: Status;
  value: string;
  derived: boolean;
}): React.JSX.Element {
  const common = 'block text-xs';
  if (value.length === 0) {
    return (
      <span id={STATUS_ID} className={`${common} text-[var(--color-muted-fg)]`}>
        URL-safe identifier — used in API keys (<code className="font-mono">rp_live_…_…</code>) and webhook URLs. Cannot be changed later.
      </span>
    );
  }
  switch (status) {
    case 'checking':
      return (
        <span id={STATUS_ID} role="status" aria-live="polite" className={`${common} text-[var(--color-muted-fg)]`}>
          Checking availability…
        </span>
      );
    case 'available':
      return (
        <span id={STATUS_ID} role="status" aria-live="polite" className={`${common} text-green-600 dark:text-green-400`}>
          ✓ <code className="font-mono">{value}</code> is available
          {derived && (
            <span className="text-[var(--color-muted-fg)]"> — from the name; edit to change</span>
          )}
        </span>
      );
    case 'taken':
      return (
        <span id={STATUS_ID} role="alert" className={`${common} text-red-600 dark:text-red-400`}>
          × <code className="font-mono">{value}</code> is already taken (slugs are globally unique)
        </span>
      );
    case 'invalid':
      return (
        <span id={STATUS_ID} role="alert" className={`${common} text-red-600 dark:text-red-400`}>
          × Must be lowercase letters, digits, hyphens. Edges alphanumeric. 2–40 chars.
        </span>
      );
    case 'error':
      return (
        <span id={STATUS_ID} role="status" aria-live="polite" className={`${common} text-amber-700 dark:text-amber-400`}>
          ! Couldn't reach the server — submit will revalidate.
        </span>
      );
    default:
      return <span id={STATUS_ID} className={`${common} text-[var(--color-muted-fg)]`} />;
  }
}
