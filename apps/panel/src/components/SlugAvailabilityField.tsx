'use client';

/**
 * Slug input with live availability feedback.
 *
 * Debounces typing (350ms), hits the panel's /api/check-slug proxy, and
 * renders a status hint underneath: ✓ available / × taken / ! invalid /
 * checking…
 *
 * The submit button is disabled when the slug is empty or known-taken/
 * invalid. We find the submit through the input's `form.elements` (an
 * HTMLFormControlsCollection, the spec-blessed form-scoped lookup) rather
 * than `querySelector`. ARIA: input exposes `aria-invalid` + a stable
 * `aria-describedby` pointing at the status message.
 */

import * as React from 'react';

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'error';

const SLUG_PATTERN = '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DEBOUNCE_MS = 350;
const STATUS_ID = 'slug-availability-status';

export function SlugAvailabilityField({
  name = 'slug',
  placeholder,
  inputClassName,
  submitName,
}: {
  name?: string;
  placeholder?: string;
  inputClassName?: string;
  /**
   * `name` attribute of the submit button to disable, if there's more
   * than one form-control with `type="submit"`. Defaults to the first
   * one in `form.elements` matching `type="submit"`.
   */
  submitName?: string;
}): React.JSX.Element {
  const [value, setValue] = React.useState('');
  const [status, setStatus] = React.useState<Status>('idle');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const seqRef = React.useRef(0);

  // Form-scoped submit lookup via the spec-blessed HTMLFormControlsCollection.
  // Falls back to a single querySelector if `name` isn't provided. Works
  // across re-renders because we re-resolve every effect run.
  function findSubmit(): HTMLButtonElement | null {
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
  }

  React.useEffect(() => {
    const btn = findSubmit();
    if (!btn) return;
    const blocked =
      value.length === 0 || status === 'taken' || status === 'invalid' || status === 'checking';
    btn.disabled = blocked;
    btn.classList.toggle('opacity-50', blocked);
    btn.classList.toggle('cursor-not-allowed', blocked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, value]);

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

  const invalid = status === 'taken' || status === 'invalid';

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        name={name}
        required
        autoComplete="off"
        spellCheck={false}
        pattern={SLUG_PATTERN}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value.trim().toLowerCase())}
        className={inputClassName}
        aria-invalid={invalid || undefined}
        aria-describedby={STATUS_ID}
      />
      <SlugStatus status={status} value={value} />
    </>
  );
}

function SlugStatus({ status, value }: { status: Status; value: string }): React.JSX.Element {
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
