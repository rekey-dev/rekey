'use client';

/**
 * The currencies a price can be in, held once per page and read by every
 * currency field on it.
 *
 * A plans page has a currency field per plan dialog. Giving each one its own
 * copy of 150 options made the page heavy for no gain, so the options are one
 * `<datalist>` and each field is a text input that lists from it.
 */

import * as React from 'react';
import {
  currencyChoice,
  notSoldReason,
  priceCurrencyChoices,
  unchargeableReason,
  type ChargingProvider,
} from '@/lib/price-currencies';

interface Catalog {
  listId: string;
  /** Null when the page lists currencies for something no provider charges, such as a reporting currency. */
  providers: readonly ChargingProvider[] | null;
}

const CatalogContext = React.createContext<Catalog | null>(null);

export function CurrencyCatalog({
  providers,
  first,
  children,
}: {
  /**
   * From `toChargingProviders`. Null lists every currency without saying who
   * can charge it, for a field that names a currency nobody is charged in.
   */
  providers: readonly ChargingProvider[] | null;
  /** Listed first: the Application's reporting currency. */
  first?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const listId = `rekey-currencies-${React.useId()}`;
  const choices = React.useMemo(() => priceCurrencyChoices(providers ?? [], first), [providers, first]);
  const catalog = React.useMemo(() => ({ listId, providers }), [listId, providers]);
  return (
    <CatalogContext.Provider value={catalog}>
      <datalist id={listId}>
        {choices.map((choice) => (
          <option key={choice.code} value={choice.code}>
            {providers === null || choice.chargedBy.length > 0
              ? choice.name
              : `${choice.name} (no enabled provider can charge it)`}
          </option>
        ))}
      </datalist>
      {children}
    </CatalogContext.Provider>
  );
}

export interface CurrencyVerdict {
  /** Why the code cannot be saved at all. The field is then invalid. */
  refusal: string | null;
  /** Why a price in it would not be charged today. The field is still valid. */
  warning: string | null;
}

/**
 * What to say about a typed currency: a refusal for one Rekey does not sell
 * in, a warning for one no enabled provider can charge. With no catalog on
 * the page there is nothing to judge chargeability by, so no warning.
 */
export function useCurrencyVerdict(raw: string, exclude?: { codes: readonly string[]; reason: string }): CurrencyVerdict {
  const catalog = React.useContext(CatalogContext);
  const code = raw.trim().toUpperCase();
  const notSold = notSoldReason(code);
  if (notSold !== null) return { refusal: notSold, warning: null };
  if (code !== '' && exclude?.codes.includes(code)) return { refusal: exclude.reason, warning: null };
  if (code === '' || catalog === null || catalog.providers === null) return { refusal: null, warning: null };
  return { refusal: null, warning: unchargeableReason(currencyChoice(code, catalog.providers)) };
}

/**
 * A currency field: a three-letter code, suggested from the catalog. A code
 * Rekey does not sell in is refused in the field with the reason, before any
 * submit. One nobody can charge yet is allowed and says what would fix it.
 */
export function CurrencyInput({
  name,
  value,
  onChange,
  required,
  className,
  exclude,
  placeholder = 'USD',
  'aria-label': ariaLabel,
}: {
  name: string;
  value: string;
  onChange: (code: string) => void;
  required?: boolean;
  className: string;
  /** Codes this field must not take, with the sentence that says why. */
  exclude?: { codes: readonly string[]; reason: string };
  placeholder?: string;
  'aria-label'?: string;
}): React.JSX.Element {
  const catalog = React.useContext(CatalogContext);
  const noteId = `currency-note-${React.useId()}`;
  const verdict = useCurrencyVerdict(value, exclude);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current?.setCustomValidity(verdict.refusal ?? '');
  }, [verdict.refusal]);
  const note = verdict.refusal ?? verdict.warning;

  return (
    <>
      <input
        ref={ref}
        name={name}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value.toUpperCase())}
        required={required}
        minLength={3}
        maxLength={3}
        placeholder={placeholder}
        autoComplete="off"
        list={catalog?.listId}
        aria-label={ariaLabel}
        aria-invalid={verdict.refusal !== null || undefined}
        aria-describedby={note ? noteId : undefined}
        className={`${className} font-mono uppercase`}
      />
      {note && (
        <span
          id={noteId}
          role={verdict.refusal ? 'alert' : 'status'}
          className={`block text-xs ${verdict.refusal ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}
        >
          {note}
        </span>
      )}
    </>
  );
}
