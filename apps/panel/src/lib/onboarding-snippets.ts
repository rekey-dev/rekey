/**
 * Copy-paste examples for the Onboarding page, filled in with the
 * Application's own question keys.
 */

import type { ProfileField } from '@rekey.dev/shared-types';

export interface OnboardingSnippet {
  label: string;
  when: string;
  code: string;
}

function sampleValue(f: ProfileField): string {
  if (f.type === 'select') return JSON.stringify(f.options?.[0] ?? '');
  if (f.type === 'number') return '12';
  if (f.type === 'boolean') return 'true';
  if (f.type === 'url') return JSON.stringify('https://example.com');
  if (f.type === 'date') return JSON.stringify('2026-01-31');
  return `String(formData.get(${JSON.stringify(f.key)}))`;
}

export function onboardingSnippets(fields: ProfileField[]): OnboardingSnippet[] {
  const userFields = fields.filter((f) => f.writableBy === 'user').slice(0, 3);
  const sample = userFields.length > 0 ? userFields : [{ key: 'company', type: 'text' } as ProfileField];
  const answers = sample.map((f) => `    ${f.key}: ${sampleValue(f)},`).join('\n');
  return [
    {
      label: 'Decide where a user goes',
      when: 'Rekey never redirects anyone. Read the status on your server and choose: send pending users to your form, let skipped ones through, or not.',
      code: `// lib/rekey.ts
import { Rekey } from '@rekey.dev/node';
export const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

// lib/onboarding-gate.ts: call it at the top of a Server Component or layout
import { redirect } from 'next/navigation';
import { auth } from '@rekey.dev/nextjs/server';
import { rekey } from './rekey';

export async function requireOnboarding(): Promise<void> {
  const session = await auth();
  if (!session) redirect('/sign-in');
  const user = await rekey.users.get(session.user.id);
  if (user.onboardingStatus === 'pending') redirect('/welcome');
  // 'skipped': they chose to skip. Let them in, or ask again later.
  // 'completed': every required question was answered.
}`,
    },
    {
      label: 'Save the answers and complete',
      when: 'From your onboarding form. Completing is refused with PROFILE_INCOMPLETE until every required question has an answer.',
      code: `// app/welcome/actions.ts, using lib/rekey.ts from the example above
'use server';
import { redirect } from 'next/navigation';
import { auth } from '@rekey.dev/nextjs/server';
import { rekey } from '@/lib/rekey';

export async function finishOnboarding(formData: FormData) {
  const session = await auth();
  if (!session) redirect('/sign-in');
  await rekey.users.updateProfile(session.user.id, {
${answers}
  });
  await rekey.users.completeOnboarding(session.user.id);
  redirect('/dashboard');
}`,
    },
    {
      label: 'Let the user skip',
      when: 'A "Skip for now" button. Nothing is checked; Rekey records when they skipped and sends user.onboarding_skipped.',
      code: `// app/welcome/actions.ts
export async function skipOnboarding() {
  const session = await auth();
  if (!session) redirect('/sign-in');
  await rekey.users.skipOnboarding(session.user.id);
  redirect('/dashboard');
}

// Or from the browser with @rekey.dev/react:
// await client.skipOnboarding(accessToken);
// await client.completeOnboarding(accessToken);`,
    },
    {
      label: 'Read the questions',
      when: 'To render your form. A publishable key gets only the questions the user may answer. When the Application has allowed sites, a publishable key is refused without one of them as the Origin, which a browser sends for you.',
      code: `# Replace the Origin with one of your allowed sites (Developer, Allowed origins & IPs).
curl "$REKEY_URL/api/v1/profile-schema" \\
  -H "Authorization: Bearer $REKEY_PUBLIC_KEY" \\
  -H "Origin: https://your-site.example"
# { "data": { "fields": [ { "key": "company", "label": "Company", "type": "text", "requiredForOnboarding": true } ] } }`,
    },
  ];
}
