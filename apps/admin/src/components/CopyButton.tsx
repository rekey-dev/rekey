'use client';

import * as React from 'react';

/**
 * Tiny clipboard-copy affordance next to long opaque identifiers (cuids).
 * Operators copy ids into support tickets / DB queries dozens of times per
 * shift; a one-click copy is materially less annoying than triple-click +
 * scroll-overflow.
 *
 * Renders as a 16x16 button. The label is the icon ("⧉" before, "✓" after);
 * an `aria-label` carries the action for screen readers. Falls back to a
 * temporary textarea+`execCommand` if the `Clipboard API` isn't available
 * (older Safari, insecure-context dev).
 */
export function CopyButton({
  value,
  label = 'Copy id',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        // Legacy fallback. Build a hidden textarea, select, execCommand.
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Surface failure briefly. Most likely cause is a strict CSP — the
      // operator can still triple-click the visible id.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={`inline-grid h-4 w-4 place-items-center rounded text-[10px] text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 ${className}`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/**
 * Convenience wrapper for the common "render a truncated id with a copy
 * button next to it" pattern. Renders `<prefix><ellipsis>` as the visible
 * label and a `CopyButton` carrying the full value.
 */
export function CuidWithCopy({
  value,
  visibleChars = 8,
}: {
  value: string | null | undefined;
  visibleChars?: number;
}): React.JSX.Element {
  if (!value) return <span className="text-[var(--color-faint-fg)]">—</span>;
  const display = value.length <= visibleChars + 1 ? value : `${value.slice(0, visibleChars)}…`;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-[11px]">{display}</span>
      <CopyButton value={value} label={`Copy ${value}`} />
    </span>
  );
}
