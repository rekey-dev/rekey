/**
 * Lists: labels and form parsing shared by the list pages. The API validates
 * everything again; this only turns form fields into the body it expects.
 */

import {
  CONTACT_LAWFUL_BASES,
  CONTACT_LIST_KEY_RE,
  CONTACT_LIST_KINDS,
  ContactFieldSchemaSchema,
  type ContactFieldDef,
  type ContactLawfulBasis,
  type ContactListDto,
  type ContactListKind,
} from '@rekey.dev/shared-types';

export const KIND_LABEL: Record<ContactListKind, string> = {
  newsletter: 'Newsletter',
  waitlist: 'Waitlist',
  contact_form: 'Contact form',
  generic: 'Other',
};

export const LAWFUL_BASIS_LABEL: Record<ContactLawfulBasis, string> = {
  consent: 'Consent (they tick a box)',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract (they asked for it)',
};

export const LAWFUL_BASIS_SHORT: Record<ContactLawfulBasis, string> = {
  consent: 'Consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
};

export function isListKey(value: string): boolean {
  return CONTACT_LIST_KEY_RE.test(value);
}

export function readKind(value: FormDataEntryValue | null): ContactListKind {
  return (CONTACT_LIST_KINDS as readonly string[]).includes(String(value)) ? (value as ContactListKind) : 'generic';
}

export function readLawfulBasis(value: FormDataEntryValue | null): ContactLawfulBasis {
  return (CONTACT_LAWFUL_BASES as readonly string[]).includes(String(value))
    ? (value as ContactLawfulBasis)
    : 'consent';
}

/** The field editor posts its rows as JSON in one hidden input. */
export function parseFieldSchema(raw: string): { ok: true; defs: ContactFieldDef[] } | { ok: false } {
  try {
    const parsed = ContactFieldSchemaSchema.safeParse(JSON.parse(raw || '[]'));
    return parsed.success ? { ok: true, defs: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Where a list stands on browser capture. `browser-no-sites` is a list with
 * Public capture on while the Application has no allowed site left, so every
 * browser subscribe is refused.
 */
export type CaptureState = 'server-only' | 'browser' | 'browser-no-sites';

export function captureState(publicCapture: boolean, allowedOrigins: readonly string[]): CaptureState {
  if (!publicCapture) return 'server-only';
  return allowedOrigins.length > 0 ? 'browser' : 'browser-no-sites';
}

/** What a subscribe must carry for the list's lawful basis, in a few words. */
export function consentSummary(list: Pick<ContactListDto, 'lawfulBasis' | 'consentVersion' | 'consentText'>): string {
  if (list.lawfulBasis !== 'consent') return `${LAWFUL_BASIS_SHORT[list.lawfulBasis]}, no checkbox`;
  if (list.consentVersion === 0 || !list.consentText) return 'Checkbox, no text set yet';
  return `Checkbox, version ${list.consentVersion}`;
}

export function retentionSummary(days: number | null): string {
  return days === null ? 'Kept until the person is erased' : `Deleted after ${days} ${days === 1 ? 'day' : 'days'}`;
}

export interface Snippet {
  label: string;
  language: string;
  code: string;
  /** Only works once the list has Public capture on. */
  needsPublicCapture: boolean;
  /** When to pick this one, in a sentence. */
  when: string;
}

export type SnippetList = Pick<
  ContactListDto,
  'key' | 'kind' | 'fieldSchema' | 'lawfulBasis' | 'consentVersion' | 'consentText'
>;

function fieldInput(f: ContactFieldDef): string {
  const req = f.required ? ' required' : '';
  if (f.type === 'textarea') return `<textarea name="${f.name}" placeholder={${JSON.stringify(f.label)}}${req} />`;
  if (f.type === 'checkbox') return `<label><input type="checkbox" name="${f.name}"${req} /> {${JSON.stringify(f.label)}}</label>`;
  if (f.type === 'select') {
    const options = (f.options ?? []).map((o) => `<option>{${JSON.stringify(o)}}</option>`).join('');
    return `<select name="${f.name}"${req}>${options}</select>`;
  }
  const type = f.type === 'email' || f.type === 'url' || f.type === 'number' ? f.type : 'text';
  return `<input type="${type}" name="${f.name}" placeholder={${JSON.stringify(f.label)}}${req} />`;
}

/** Copy-paste examples for one list, all reading the key and URL from the environment. */
export function listSnippets(list: SnippetList): Snippet[] {
  const { key, consentVersion } = list;
  const needsConsent = list.lawfulBasis === 'consent';
  const consentLabel = JSON.stringify(list.consentText ?? 'Email me about this.');
  const consentInputs = needsConsent
    ? `\n      <label><input type="checkbox" name="consent" required /> {${consentLabel}}</label>\n      <input type="hidden" name="consentVersion" value="${consentVersion}" />`
    : '';
  const extraInputs = list.fieldSchema.map((f) => `\n      ${fieldInput(f)}`).join('');
  const consentJson = needsConsent ? `, consent: { granted: true, version: ${consentVersion} }` : '';
  const component = list.fieldSchema.length > 0 || list.kind === 'contact_form' ? 'ContactForm' : 'NewsletterForm';
  return [
    {
      label: 'Next.js server action',
      language: 'tsx',
      needsPublicCapture: false,
      when: 'Recommended for Next.js. The secret key stays on your server and Public capture can stay off.',
      code: `// app/${key}/actions.ts
'use server';
import { redirect } from 'next/navigation';
import { subscribeToList } from '@rekey.dev/nextjs/server';

export async function join(formData: FormData) {
  // Forwards the visitor's address and marks the call as a relayed browser form.
  await subscribeToList('${key}', formData);
  redirect('/${key}/thanks');
}

// app/${key}/page.tsx
import { join } from './actions';

export default function Page() {
  return (
    <form action={join}>
      <input type="email" name="email" required />${extraInputs}${consentInputs}
      <input type="text" name="hp" hidden tabIndex={-1} autoComplete="off" />
      <button type="submit">Join</button>
    </form>
  );
}`,
    },
    {
      label: `React component (${component})`,
      language: 'tsx',
      needsPublicCapture: false,
      when: `A ready-made form that renders the consent text${component === 'ContactForm' ? ' and the list fields' : ''}. Posting through your server action, it needs no Public capture.`,
      code: `// app/${key}/page.tsx: a Server Component, posting to join() from the server action example
import { Rekey } from '@rekey.dev/node';
import { ${component} } from '@rekey.dev/react';
import { join } from './actions';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

export default async function Page() {
  const form = await rekey.lists.get('${key}');
  return <${component} list="${key}" action={join} form={form} />;
}

// Browser only, inside <RekeyProvider publishableKey=…>. Needs Public capture:
// <${component} list="${key}" />`,
    },
    {
      label: 'Any backend (Node)',
      language: 'ts',
      needsPublicCapture: false,
      when: 'Relaying a visitor form from Express, Fastify or any other Node server.',
      code: `import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

// Relaying a visitor's form: always answers { status: 'received' }.
await rekey.with({ clientIp: visitorIp }).lists.subscribe(
  '${key}',
  { email${consentJson} },
  { relay: 'browser' },
);`,
    },
    {
      label: 'Browser fetch',
      language: 'ts',
      needsPublicCapture: true,
      when: 'A static site with no server. It uses the publishable key, so the list needs Public capture.',
      code: `// Always answers 202 {status:"received"}, whatever happened to the address.
await fetch(\`\${REKEY_URL}/api/v1/lists/${key}/subscribe\`, {
  method: 'POST',
  headers: { authorization: \`Bearer \${REKEY_PUBLIC_KEY}\`, 'content-type': 'application/json' },
  body: JSON.stringify({ email${consentJson} }),
});`,
    },
    {
      label: 'curl',
      language: 'bash',
      needsPublicCapture: false,
      when: 'Adding someone from a script with a secret key. Not for relaying a visitor form.',
      code: `curl -X POST "$REKEY_URL/api/v1/lists/${key}/subscribe" \\
  -H "Authorization: Bearer $REKEY_SECRET" -H 'Content-Type: application/json' \\
  -d '{"email":"ada@example.com"${needsConsent ? `,"consent":{"granted":true,"version":${consentVersion}}` : ''}}'`,
    },
  ];
}
