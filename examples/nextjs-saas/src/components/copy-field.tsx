'use client';

import * as React from 'react';

/** A read-only monospace field with a copy button. Used to surface one-time
 *  tokens (invite tokens, password-reset links) the demo would normally email. */
export function CopyField({ value, label }: { value: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div className="flex gap-2">
        <input readOnly value={value} className="field font-mono text-xs" />
        <button
          type="button"
          className="btn-ghost shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
