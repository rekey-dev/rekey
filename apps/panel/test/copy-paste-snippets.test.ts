/**
 * The Embed and Onboarding pages hand operators code to paste. It has to
 * parse, and a label an operator typed must not be able to break it.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { ContactFieldDef } from '@rekey.dev/shared-types';
import { listSnippets } from '@/lib/lists';
import { onboardingSnippets } from '@/lib/onboarding-snippets';

function syntaxErrors(code: string): string[] {
  const file = ts.createSourceFile('snippet.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const quoted: ContactFieldDef[] = [
  { name: 'company', label: 'Company "legal" name', type: 'text', required: false, maxLength: 500 },
  { name: 'message', label: 'Say "hi"', type: 'textarea', required: true, maxLength: 2000 },
];

describe('list snippets', () => {
  it('stay valid TSX when a field label contains a double quote', () => {
    const [serverAction] = listSnippets({
      key: 'contact',
      kind: 'contact_form',
      fieldSchema: quoted,
      lawfulBasis: 'consent',
      consentVersion: 2,
      consentText: 'I agree to "the terms"',
    });
    expect(serverAction!.code).toContain('placeholder={"Company \\"legal\\" name"}');
    expect(syntaxErrors(serverAction!.code)).toEqual([]);
  });
});

describe('onboarding snippets', () => {
  const snippets = onboardingSnippets([
    { key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true, writableBy: 'user', showInList: false, pii: false },
  ]);

  it('parse as TypeScript', () => {
    for (const s of snippets.filter((x) => !x.code.startsWith('curl') && !x.code.startsWith('#'))) {
      expect(syntaxErrors(s.code), s.label).toEqual([]);
    }
  });

  it('import redirect and take the user from the session instead of an undefined userId', () => {
    for (const s of snippets.filter((x) => x.code.includes('redirect('))) {
      expect(s.code, s.label).not.toMatch(/\buserId\b/);
      expect(s.code, s.label).toContain('session.user.id');
    }
    expect(snippets[0]!.code).toContain("import { redirect } from 'next/navigation';");
  });

  it('send an Origin with the publishable key, since an Application with allowed sites refuses one without it', () => {
    const curl = snippets.find((s) => s.code.includes('curl'))!;
    expect(curl.code).toContain('-H "Origin: https://your-site.example"');
  });
});
