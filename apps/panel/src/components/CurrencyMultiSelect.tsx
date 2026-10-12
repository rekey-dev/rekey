'use client';

/**
 * The currencies one provider account can charge, picked from the list that
 * provider publishes. Every option is a checkbox named `currencies`, so the
 * form submits exactly the ticked codes. A box hidden by the search is still
 * in the form and still submitted.
 */

import * as React from 'react';
import { NO_CURRENCY_TICKED, type CurrencyOption } from '@/lib/provider-currencies';

const quietButton =
  'cursor-pointer rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

export function CurrencyMultiSelect({
  options,
  initial,
  inputClassName,
}: {
  options: readonly CurrencyOption[];
  initial: readonly string[];
  inputClassName: string;
}): React.JSX.Element {
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(() => new Set(initial));
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  const matches = (option: CurrencyOption): boolean =>
    needle === '' || option.code.toLowerCase().includes(needle) || option.name.toLowerCase().includes(needle);
  const toggle = (code: string): void =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(code)) next.add(code);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          // Enter in the search box must not submit the credential form.
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          placeholder="Search currencies"
          aria-label="Search currencies"
          className={`${inputClassName} max-w-[14rem]`}
        />
        <button type="button" className={quietButton} onClick={() => setTicked(new Set(options.map((o) => o.code)))}>
          Select all supported
        </button>
        <button type="button" className={quietButton} onClick={() => setTicked(new Set())}>
          Clear
        </button>
        <span className="text-xs text-[var(--color-muted-fg)]" aria-live="polite">
          {ticked.size === 0 ? 'None ticked' : `${ticked.size} of ${options.length} ticked`}
        </span>
      </div>
      <ul className="grid max-h-44 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-2 sm:grid-cols-2">
        {options.map((option) => (
          <li key={option.code} hidden={!matches(option)}>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-fg)]">
              <input
                type="checkbox"
                name="currencies"
                value={option.code}
                checked={ticked.has(option.code)}
                onChange={() => toggle(option.code)}
              />
              <span className="font-mono">{option.code}</span>
              <span className="truncate text-[var(--color-muted-fg)]">{option.name}</span>
            </label>
          </li>
        ))}
      </ul>
      {ticked.size === 0 && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {NO_CURRENCY_TICKED}
        </p>
      )}
    </div>
  );
}
