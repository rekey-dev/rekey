/**
 * The two profile forms: an operator editing one user's answers, and the
 * Profile fields page editing the schema. Both are server actions reading a
 * FormData, so what they send is tested by building the FormData they get.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import { answersPatch, isAnswered, isRetiredOption, ProfileFormError } from '@/lib/profile-answers';
import { fieldsFromForm } from '@/lib/profile-fields-form';
import { AnswerValue } from '@/app/(authed)/applications/[id]/end-users/[euid]/answer-value';
import { OnboardingAnswers } from '@/app/(authed)/applications/[id]/end-users/[euid]/overview-answers';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('editProfile=1'),
  usePathname: () => '/applications/app_1/end-users/eu_1',
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  redirect: () => undefined,
}));

const field = (over: Partial<ProfileField> & Pick<ProfileField, 'key' | 'type'>): ProfileField => ({
  label: over.key,
  requiredForOnboarding: false,
  writableBy: 'user',
  showInList: false,
  pii: false,
  ...over,
});

const FIELDS: ProfileField[] = [
  field({ key: 'company', type: 'text' }),
  field({ key: 'team_size', type: 'select', options: ['1', '2-10'] }),
  field({ key: 'seats', type: 'number' }),
  field({ key: 'newsletter', type: 'boolean' }),
];

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

/** What the edit dialog renders for these answers, then with some inputs changed. */
function submitted(answers: Record<string, string | number | boolean>, changed: Record<string, string>): FormData {
  const entries: Record<string, string> = {};
  for (const f of FIELDS) {
    const shown = isAnswered(answers, f.key) ? String(answers[f.key]) : '';
    entries[`o_${f.key}`] = shown;
    entries[`f_${f.key}`] = shown;
  }
  entries.types = JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f.key, f.type])));
  return form({ ...entries, ...changed });
}

describe('answersPatch', () => {
  it('sends only the fields the operator changed', () => {
    const data = submitted({ company: 'Acme', team_size: '2-10', seats: 3 }, { f_company: 'Acme Ltd' });
    expect(answersPatch(data)).toEqual({ company: 'Acme Ltd' });
  });

  it('leaves alone an answer the user added while the dialog was open', () => {
    // The dialog rendered with no newsletter answer; the user answered since.
    // The operator changed only the company, so newsletter is not sent.
    const data = submitted({ company: 'Acme' }, { f_company: 'Acme Ltd' });
    expect(answersPatch(data)).not.toHaveProperty('newsletter');
  });

  it('keeps a select answer that is no longer an option when it was not touched', () => {
    const data = submitted({ team_size: '11+' }, { f_company: 'Acme' });
    expect(answersPatch(data)).toEqual({ company: 'Acme' });
  });

  it('clears a field the operator emptied, and types numbers and booleans', () => {
    const data = submitted({ company: 'Acme', seats: 3 }, { f_company: '', f_seats: '12', f_newsletter: 'false' });
    expect(answersPatch(data)).toEqual({ company: null, seats: 12, newsletter: false });
  });
});

describe('answersPatch with a damaged form', () => {
  it.each([
    ['unparseable', 'not json'],
    ['an array', '["company"]'],
    ['a non-string type', '{"company": 1}'],
  ])('refuses %s field types instead of saving nothing', (_name, types) => {
    const data = form({ types, f_company: 'Acme', o_company: '' });
    expect(() => answersPatch(data)).toThrow(ProfileFormError);
  });

  it('refuses a form with no field types at all', () => {
    expect(() => answersPatch(form({ f_company: 'Acme' }))).toThrow(ProfileFormError);
  });
});

describe('OnboardingAnswers', () => {
  it('tells the operator a damaged form saved nothing', () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingAnswers, {
        applicationId: 'app_1',
        euid: 'eu_1',
        profile: { fields: FIELDS, answers: {}, onboardingCompletedAt: null, missingRequired: [] },
        metadata: null,
        canWrite: true,
        erased: false,
        saved: false,
        error: 'PROFILE_FORM_INVALID',
      }),
    );
    expect(html).toContain('Nothing was saved');
  });
});

describe('isAnswered and isRetiredOption', () => {
  it('does not read an inherited property as an answer', () => {
    expect(isAnswered({}, 'constructor')).toBe(false);
    expect(isAnswered({ constructor: 'x' } as Record<string, string>, 'constructor')).toBe(true);
  });

  it('flags a select answer outside the options', () => {
    expect(isRetiredOption(FIELDS[1]!, '11+')).toBe(true);
    expect(isRetiredOption(FIELDS[1]!, '1')).toBe(false);
    expect(isRetiredOption(FIELDS[0]!, 'anything')).toBe(false);
  });
});

describe('AnswerValue', () => {
  it('shows a retired option as it was answered, with a note', () => {
    const html = renderToStaticMarkup(createElement(AnswerValue, { field: FIELDS[1]!, answers: { team_size: '11+' } }));
    expect(html).toContain('11+');
    expect(html).toContain('no longer an option');
    expect(html).not.toContain('not answered');
  });

  it('shows "not answered" for a missing answer, including an inherited name', () => {
    const html = renderToStaticMarkup(
      createElement(AnswerValue, { field: field({ key: 'constructor', type: 'text' }), answers: {} }),
    );
    expect(html).toContain('not answered');
  });
});

describe('fieldsFromForm', () => {
  it('reads rows by field key, one option per line, and keeps commas inside an option', () => {
    const data = form({
      keys: JSON.stringify(['team_size', 'company']),
      k_team_size_label: 'Team size',
      k_team_size_type: 'select',
      k_team_size_options: '1\n2-10\n11, or more\n',
      k_company_label: 'Company',
      k_company_type: 'text',
      k_company_options: '',
      k_company_remove: 'on',
      new_key: 'role',
      new_label: 'Role',
      new_type: 'text',
    });
    expect(fieldsFromForm(data)).toEqual([
      expect.objectContaining({ key: 'team_size', label: 'Team size', type: 'select', options: ['1', '2-10', '11, or more'] }),
      expect.objectContaining({ key: 'role', label: 'Role', type: 'text' }),
    ]);
  });
});
