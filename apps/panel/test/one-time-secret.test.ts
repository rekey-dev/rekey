// @vitest-environment jsdom
/**
 * Every one-time secret the panel mints reaches the operator, and never by URL
 * or cookie.
 *
 * Operators reported "the token is minted but never shown". Each mint parked
 * its secret in a short-lived `rekey_reveal_*` cookie and redirected, and the
 * banner only drew if the redirect's render was committed, which on a
 * production build it often was not (`lib/commit-nudge.ts`). The webhook
 * signing secret was never shown at all; the API key and invite link only
 * showed because their forms reloaded the whole document.
 *
 * The rule now: a minting action RETURNS the secret, and `RevealActionForm`
 * shows it in a dialog from its own state. Nothing about that depends on a
 * navigation. This file pins it for every minting action, and checks the
 * dialog itself in jsdom.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RevealActionForm } from '@/components/RevealActionForm';
import type { RevealResult } from '@/lib/one-time-secret';
import { serverActions, sourceFiles, stripComments } from './server-actions';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const app = (...p: string[]): string => path.join(srcDir, 'app', '(authed)', ...p);

/**
 * Every Server Action that mints a secret the operator must copy, with the
 * page whose form submits it. A new one belongs here.
 */
const MINTS: { action: string; file: string; form: string }[] = [
  { action: 'createKey', file: app('applications', '[id]', 'api-keys', 'page.tsx'), form: app('applications', '[id]', 'api-keys', 'page.tsx') },
  { action: 'createEndpoint', file: app('applications', '[id]', 'webhooks', 'page.tsx'), form: app('applications', '[id]', 'webhooks', 'page.tsx') },
  { action: 'rotateSecret', file: app('applications', '[id]', 'webhooks', '[endpointId]', 'page.tsx'), form: app('applications', '[id]', 'webhooks', '[endpointId]', 'page.tsx') },
  { action: 'invite', file: app('team', 'page.tsx'), form: app('team', 'page.tsx') },
  { action: 'issueLicense', file: app('applications', '[id]', 'licenses', 'page.tsx'), form: app('applications', '[id]', 'licenses', 'page.tsx') },
  { action: 'revealOrgLicenseKey', file: app('applications', '[id]', 'organizations', '[orgId]', 'page.tsx'), form: app('applications', '[id]', 'organizations', '[orgId]', 'page.tsx') },
  { action: 'mintToken', file: app('account', 'api-tokens', 'page.tsx'), form: app('account', 'api-tokens', 'page.tsx') },
  { action: 'impersonate', file: app('applications', '[id]', 'end-users', '[euid]', 'actions.ts'), form: app('applications', '[id]', 'end-users', '[euid]', 'security', 'page.tsx') },
];

describe('every minting action returns its secret', () => {
  for (const mint of MINTS) {
    describe(mint.action, () => {
      const action = serverActions(readFileSync(mint.file, 'utf8')).find((a) => a.name === mint.action);

      it('is a Server Action in the file this list names', () => {
        expect(action, `${mint.action} not found as a Server Action in ${path.relative(srcDir, mint.file)}`).toBeDefined();
      });

      it('returns the secret instead of parking it for a redirect', () => {
        const body = action!.body;
        expect(body, `${mint.action} must return { secret } for RevealActionForm to show`).toMatch(/return\s*\{\s*secret:/);
        expect(body, `${mint.action} must not hand its secret to a cookie`).not.toMatch(/\bcookies\s*\(/);
        // The success path revalidates so the table behind the dialog has the new row.
        expect(body, `${mint.action} must revalidate the page it was submitted from`).toMatch(/\brevalidatePath\s*\(/);
      });

      it('is submitted through RevealActionForm', () => {
        const form = stripComments(readFileSync(mint.form, 'utf8'));
        expect(form).toMatch(new RegExp(`<RevealActionForm[^>]*action=\\{${mint.action}\\b`));
      });
    });
  }

  it('the panel has no reveal cookie left anywhere', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (/rekey_reveal_|rekey_mint_flash|rekey_pat_reveal|rekey_impersonate_reveal/.test(text)) {
        offenders.push(path.relative(srcDir, file));
      }
    }
    expect(offenders, 'A one-time secret must reach the dialog in the action response, not a cookie').toEqual([]);
  });

  it('every action that returns a secret is on the list above', () => {
    const listed = new Set(MINTS.map((m) => m.action));
    const unlisted: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      for (const a of serverActions(readFileSync(file, 'utf8'))) {
        if (/return\s*\{\s*secret:/.test(a.body) && !listed.has(a.name)) unlisted.push(`${path.relative(srcDir, file)} ${a.name}`);
      }
    }
    expect(unlisted).toEqual([]);
  });
});

describe('RevealActionForm shows what the action returned', () => {
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function submit(result: RevealResult): Promise<void> {
    const action = async (): Promise<RevealResult> => result;
    await act(async () => {
      root.render(
        React.createElement(RevealActionForm, { action }, React.createElement('button', { type: 'submit' }, 'Mint')),
      );
    });
    await act(async () => {
      container.querySelector('form')!.requestSubmit(container.querySelector('button'));
    });
  }

  it('opens the one-time dialog with the secret, the warning and the notes', async () => {
    await submit({ secret: { title: 'Your new API key', value: 'rp_test_abc123', notes: ['Only a hash is stored.'] } });
    const dialog = container.querySelector('dialog[data-one-time-secret]');
    expect(dialog, 'no one-time secret dialog after the action returned a secret').not.toBeNull();
    expect(dialog!.textContent).toContain('rp_test_abc123');
    expect(dialog!.textContent).toContain('Your new API key');
    expect(dialog!.textContent).toContain('Shown once.');
    expect(dialog!.textContent).toContain('Only a hash is stored.');
  });

  it('drops the secret when the operator is done with it', async () => {
    await submit({ secret: { title: 'Your new API key', value: 'rp_test_abc123' } });
    const done = [...container.querySelectorAll('dialog[data-one-time-secret] button')].find((b) =>
      /stored it|Done/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    await act(async () => done.click());
    expect(container.querySelector('dialog[data-one-time-secret]')).toBeNull();
    expect(container.textContent).not.toContain('rp_test_abc123');
  });

  it('shows nothing when the action returned nothing (it redirected instead)', async () => {
    await submit(undefined);
    expect(container.querySelector('dialog[data-one-time-secret]')).toBeNull();
  });
});

describe('a successful mint clears the refusal before it', () => {
  // A refusal redirects to `?error=…`; a success revalidates without
  // navigating, so the URL and every banner drawn from it used to keep saying
  // the previous attempt was refused, right beside the new secret.
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
    window.history.replaceState(null, '', '/');
  });

  async function mint(result: RevealResult, clearParams?: string[]): Promise<void> {
    const action = async (): Promise<RevealResult> => result;
    await act(async () => {
      root.render(
        React.createElement(
          RevealActionForm,
          { action, ...(clearParams ? { clearParams } : {}) },
          React.createElement('button', { type: 'submit' }, 'Mint'),
        ),
      );
    });
    await act(async () => {
      container.querySelector('form')!.requestSubmit(container.querySelector('button'));
    });
  }

  it('drops ?error= (and the named flags) from the URL when the mint succeeds', async () => {
    window.history.replaceState(null, '', '/applications/a/webhooks?error=WEBHOOK_URL_UNSAFE&newWebhook=1&url=x&keep=1');
    await mint({ secret: { title: 't', value: 'v' } }, ['url']);
    const sp = new URLSearchParams(window.location.search);
    expect(
      sp.has('error'),
      'The refusal flag survived a successful mint, so its banner keeps telling the operator the mint failed.',
    ).toBe(false);
    expect(sp.has('url')).toBe(false);
    // The modal flag is the modal's to clear when it closes; unrelated params stay.
    expect(sp.get('newWebhook')).toBe('1');
    expect(sp.get('keep')).toBe('1');
  });

  it('leaves the URL alone when the action refused (it redirected, nothing returned)', async () => {
    window.history.replaceState(null, '', '/team?error=missing');
    await mint(undefined);
    expect(new URLSearchParams(window.location.search).get('error')).toBe('missing');
  });

  it("every minting page draws its refusal banner through WhileUrlHas", () => {
    for (const file of new Set(MINTS.map((m) => m.form))) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // Only pages that render a refusal from the URL at all.
      if (!/sp\.(error|impError)\b/.test(src)) continue;
      expect(src, path.relative(srcDir, file)).toMatch(/<WhileUrlHas param=/);
    }
  });
});
