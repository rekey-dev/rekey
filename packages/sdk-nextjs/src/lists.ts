import { headers } from 'next/headers';
import { RekeyError, normalizeClientIp, type ListSubscribeRequest } from '@rekey.dev/node';
import { visitorClient, visitorIpFrom, type VisitorOptions } from './server.js';

/** Form fields `subscribeToList` reads itself; every other field goes into `fields`. */
const RESERVED = new Set(['email', 'name', 'consent', 'consentVersion', 'hp', 'sourceUrl']);

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Read a form's fields into a subscribe body. `consent` is a checkbox and
 * `consentVersion` a hidden input carrying the version `rekey.lists.get`
 * returned; Next's own `$ACTION_*` fields are skipped.
 */
export function subscribeInputFromForm(form: FormData, referer?: string | null): ListSubscribeRequest {
  const fields: Record<string, string> = {};
  form.forEach((value, name) => {
    if (RESERVED.has(name) || name.startsWith('$ACTION') || typeof value !== 'string') return;
    fields[name] = value;
  });
  const version = Number(text(form, 'consentVersion'));
  const consented = form.get('consent') !== null && Number.isInteger(version);
  const name = text(form, 'name');
  const hp = text(form, 'hp');
  const sourceUrl = text(form, 'sourceUrl') ?? referer ?? undefined;
  return {
    email: text(form, 'email') ?? '',
    ...(name !== undefined && { name }),
    ...(Object.keys(fields).length > 0 && { fields }),
    ...(consented && { consent: { granted: true as const, version } }),
    ...(hp !== undefined && { hp }),
    ...(sourceUrl !== undefined && { sourceUrl }),
  };
}

/**
 * Server action: add the visitor to a list with your secret key, sending
 * their address. Recommended over a browser subscribe: nothing about the list
 * is exposed to the page, and it works without turning on Public capture.
 *
 * Because the call names the visitor, the API treats it as the browser it
 * relays (it also sends `X-Rekey-Relay: browser`, so that holds even if the
 * address were lost): the per-visitor, per-list and daily limits apply, it can never add
 * back someone who unsubscribed or rename a contact, and it always resolves
 * `{ status: 'received' }`. Return that to the page as it is. It refuses to
 * run without a visitor address (set `REKEY_TRUSTED_PROXY_HOPS`, or pass
 * `clientIp`), since without one none of that would hold.
 *
 * Takes the form's `FormData` (fields named `email`, `name`, `consent`,
 * `consentVersion`, `hp`, plus the list's own fields) or a ready body.
 *
 * @example
 * ```tsx
 * // app/waitlist/actions.ts
 * 'use server';
 * import { subscribeToList } from '@rekey.dev/nextjs/server';
 *
 * export async function join(formData: FormData) {
 *   await subscribeToList('waitlist', formData);
 * }
 * ```
 */
export async function subscribeToList(
  key: string,
  input: FormData | ListSubscribeRequest,
  options: VisitorOptions = {},
): Promise<{ status: 'received' }> {
  const h = await headers();
  // Normalised here, not only in the SDK: the SDK silently drops a value that
  // is not one IP address, and the call would then reach the API with no
  // visitor at all.
  const clientIp = normalizeClientIp(options.clientIp === undefined ? visitorIpFrom(h) : options.clientIp);
  if (!clientIp) {
    throw new RekeyError({
      code: 'CLIENT_IP_MISSING',
      message: '@rekey.dev/nextjs: subscribeToList needs the visitor address, and none that is one IP address was found for this request.',
      fix:
        'Set REKEY_TRUSTED_PROXY_HOPS to the number of proxies in front of this app so the address is read ' +
        'from X-Forwarded-For, or pass { clientIp } yourself. To add someone from your own code rather ' +
        'than a visitor form, call rekey.lists.subscribe from @rekey.dev/node instead.',
    });
  }
  const body = input instanceof FormData ? subscribeInputFromForm(input, h.get('referer')) : input;
  await (await visitorClient(clientIp)).lists.subscribe(key, body, { relay: 'browser' });
  return { status: 'received' };
}
