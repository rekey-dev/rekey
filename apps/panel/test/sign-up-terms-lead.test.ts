import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { termsLead } from '@/app/sign-up/terms-lead';

const page = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'sign-up', 'page.tsx'),
  'utf8',
);

describe('sign-up terms line', () => {
  it('does not claim a workspace is created when joining one through an invite', () => {
    expect(termsLead(true)).not.toMatch(/workspace/);
    expect(termsLead(true)).toContain('creating an account');
  });

  it('names the workspace on a plain sign-up', () => {
    expect(termsLead(false)).toContain('creating a workspace');
  });

  it('is what the page renders, keyed on the invite', () => {
    expect(page).toContain('{termsLead(Boolean(joinKey))}');
    expect(page).not.toContain('By creating a workspace you agree');
  });
});
