'use client';

/**
 * List forms: a newsletter or waitlist signup, and a contact form. They post
 * from the browser with the publishable key (the list needs Public capture),
 * or to your own Server Action, which is the recommended path because nothing
 * about the list is exposed and Public capture can stay off.
 */

import * as React from 'react';
import type { ContactFieldDef, ContactListPublicDto, ListSubscribeRequest } from '@rekey.dev/shared-types';
import { RekeyError } from '@rekey.dev/shared-types/error';
import { useOptionalRekeyContext } from './context.js';
import { Themed, useCx, type AppearanceProp } from './theme.js';
import type { FormAction } from './auth-components.js';

type FieldValue = string | number | boolean;

/** What the form collected, before it is turned into a subscribe. */
export interface ListSubscribeValues {
  email: string;
  name?: string;
  fields?: Record<string, FieldValue>;
  /** Whether the person ticked the consent box. */
  consent?: boolean;
  /** The honeypot. Leave it empty; a bot fills it. */
  hp?: string;
}

export interface UseListSubscribe {
  /** The list's form, once loaded. Null while loading, or when `form` was not given and the load failed. */
  form: ContactListPublicDto | null;
  status: 'loading' | 'idle' | 'submitting' | 'done' | 'error';
  error: RekeyError | null;
  submit: (values: ListSubscribeValues) => Promise<boolean>;
}

/**
 * Load a list's form and subscribe from the browser with the publishable key.
 * `submit` resolves true when the API accepted the request; the answer is the
 * same whatever happened to the address.
 *
 * @example
 * ```tsx
 * const { form, status, submit } = useListSubscribe('waitlist');
 * await submit({ email, consent: true });
 * ```
 */
function missingProvider(): RekeyError {
  return new RekeyError({
    code: 'CONFIG_MISSING_PROVIDER',
    message: '@rekey.dev/react: a browser subscribe needs <RekeyProvider publishableKey="rp_pub_…">.',
    fix: 'Wrap the form in <RekeyProvider>, or pass `action` (your Server Action) and `form` to post through your server.',
  });
}

export function useListSubscribe(key: string, initial?: ContactListPublicDto): UseListSubscribe {
  const client = useOptionalRekeyContext()?.client ?? null;
  const [form, setForm] = React.useState<ContactListPublicDto | null>(initial ?? null);
  const [status, setStatus] = React.useState<UseListSubscribe['status']>(initial ? 'idle' : 'loading');
  const [error, setError] = React.useState<RekeyError | null>(null);

  React.useEffect(() => {
    if (initial) return;
    if (!client) {
      setError(missingProvider());
      setStatus('error');
      return;
    }
    let live = true;
    client.getList(key).then(
      (loaded) => {
        if (!live) return;
        setForm(loaded);
        setStatus('idle');
      },
      (err: RekeyError) => {
        if (!live) return;
        setError(err);
        setStatus('error');
      },
    );
    return () => {
      live = false;
    };
  }, [client, key, initial]);

  const submit = React.useCallback(
    async (values: ListSubscribeValues): Promise<boolean> => {
      if (!client) {
        setError(missingProvider());
        setStatus('error');
        return false;
      }
      setStatus('submitting');
      setError(null);
      const body: ListSubscribeRequest = {
        email: values.email,
        ...(values.name && { name: values.name }),
        ...(values.fields && Object.keys(values.fields).length > 0 && { fields: values.fields }),
        ...(values.consent && form && { consent: { granted: true as const, version: form.consent.version } }),
        ...(values.hp && { hp: values.hp }),
        ...(typeof window !== 'undefined' && { sourceUrl: window.location.href }),
      };
      try {
        await client.subscribeToList(key, body);
        setStatus('done');
        return true;
      } catch (err) {
        setError(err as RekeyError);
        setStatus('error');
        return false;
      }
    },
    [client, key, form],
  );

  return { form, status, error, submit };
}

export interface ListFormProps {
  /** The list key, e.g. `waitlist`. */
  list: string;
  /**
   * Your Server Action. The form posts `email`, `name`, `consent`,
   * `consentVersion`, `hp` and each list field to it, which is exactly what
   * `subscribeToList` from `@rekey.dev/nextjs/server` reads. Without it the
   * browser subscribes with the publishable key.
   */
  action?: FormAction;
  /**
   * The list's form, from `rekey.lists.get(key)` on your server. Needed with
   * `action` when the list keeps Public capture off, since the browser cannot
   * load it then. Without it the component loads it with the publishable key.
   */
  form?: ContactListPublicDto;
  title?: string;
  submitLabel?: string;
  /** Shown after the browser subscribe succeeds. */
  successMessage?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function readValues(data: FormData, fields: ContactFieldDef[]): ListSubscribeValues {
  const text = (name: string): string => String(data.get(name) ?? '').trim();
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.type === 'checkbox') values[f.name] = data.get(f.name) !== null;
    else if (text(f.name) !== '') values[f.name] = f.type === 'number' ? Number(text(f.name)) : text(f.name);
  }
  return {
    email: text('email'),
    ...(text('name') && { name: text('name') }),
    fields: values,
    consent: data.get('consent') !== null,
    ...(text('hp') && { hp: text('hp') }),
  };
}

function FieldInput({ field }: { field: ContactFieldDef }): React.JSX.Element {
  const cx = useCx();
  const id = `rekey-list-${field.name}`;
  const common = { id, name: field.name, required: field.required, className: cx('rekey-input', 'input') };
  if (field.type === 'checkbox') {
    return (
      <label className="rekey-field" htmlFor={id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input id={id} name={field.name} type="checkbox" required={field.required} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <div className="rekey-field">
      <label className={cx('rekey-label', 'label')} htmlFor={id}>
        {field.label}
      </label>
      {field.type === 'textarea' ? (
        <textarea {...common} maxLength={field.maxLength} rows={4} />
      ) : field.type === 'select' ? (
        <select {...common} defaultValue="">
          <option value="" disabled>
            Choose…
          </option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input {...common} type={field.type === 'number' ? 'number' : field.type} maxLength={field.maxLength} />
      )}
    </div>
  );
}

function ListFormBody({
  list,
  action,
  form: given,
  title,
  submitLabel,
  successMessage,
  withFields,
}: ListFormProps & { withFields: boolean }): React.JSX.Element {
  const cx = useCx();
  const browser = useListSubscribe(list, given);
  const form = given ?? browser.form;
  const fields = withFields ? (form?.fieldSchema ?? []) : [];
  const needsConsent = form?.consent.lawfulBasis === 'consent';

  if (!action && browser.status === 'done') {
    return (
      <div className={cx('rekey-card', 'card')}>
        <div role="status" className={cx('rekey-alert rekey-alert-info', 'alert')}>
          {successMessage}
        </div>
      </div>
    );
  }

  const onSubmit = action
    ? undefined
    : (e: React.FormEvent<HTMLFormElement>): void => {
        e.preventDefault();
        void browser.submit(readValues(new FormData(e.currentTarget), fields));
      };

  return (
    <div className={cx('rekey-card', 'card')}>
      {title && (
        <div className={cx('rekey-header', 'header')}>
          <h2 className={cx('rekey-title', 'title')}>{title}</h2>
        </div>
      )}
      {!action && browser.error && browser.status === 'error' && (
        <div role="alert" className={cx('rekey-alert rekey-alert-error', 'alert')}>
          {browser.error.message}
        </div>
      )}
      <form {...(action ? { action } : { onSubmit })} className="rekey-stack">
        <div className="rekey-field">
          <label className={cx('rekey-label', 'label')} htmlFor={`rekey-list-${list}-email`}>
            Email
          </label>
          <input
            id={`rekey-list-${list}-email`}
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className={cx('rekey-input', 'input')}
          />
        </div>
        {fields.map((f) => (
          <FieldInput key={f.name} field={f} />
        ))}
        {needsConsent && form && (
          <label className="rekey-field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <input type="checkbox" name="consent" required />
            <span>{form.consent.text ?? 'I agree to be contacted.'}</span>
          </label>
        )}
        {form && <input type="hidden" name="consentVersion" value={form.consent.version} />}
        <input
          type="text"
          name="hp"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        />
        <button
          type="submit"
          disabled={browser.status === 'submitting' || (!action && !form)}
          className={cx('rekey-btn rekey-btn-primary rekey-btn-block', 'buttonPrimary')}
        >
          {browser.status === 'submitting' ? 'Sending…' : submitLabel}
        </button>
      </form>
    </div>
  );
}

/**
 * A newsletter or waitlist signup: email, the list's consent checkbox, and a
 * hidden honeypot.
 *
 * @example
 * ```tsx
 * <NewsletterForm list="waitlist" title="Join the waitlist" />
 * // or, with your Server Action and Public capture off:
 * <NewsletterForm list="waitlist" action={join} form={await rekey.lists.get('waitlist')} />
 * ```
 */
export function NewsletterForm(props: ListFormProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <ListFormBody
        {...props}
        submitLabel={props.submitLabel ?? 'Subscribe'}
        successMessage={props.successMessage ?? 'Thanks. You are on the list.'}
        withFields={false}
      />
    </Themed>
  );
}

/**
 * A contact form that renders the list's own fields (from its field schema)
 * below the email address.
 *
 * @example
 * ```tsx
 * <ContactForm list="contact" title="Get in touch" />
 * ```
 */
export function ContactForm(props: ListFormProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <ListFormBody
        {...props}
        submitLabel={props.submitLabel ?? 'Send'}
        successMessage={props.successMessage ?? 'Thanks. Your message was sent.'}
        withFields
      />
    </Themed>
  );
}
