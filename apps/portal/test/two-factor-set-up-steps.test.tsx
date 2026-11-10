// @vitest-environment jsdom
/**
 * The status line above two-factor setup describes the step the customer is
 * on: "Off." before setup starts, nothing while they scan the code, and the
 * "on" confirmation alone once it is on, all without a reload.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { TwoFactorSetUpSteps } = await import('@/components/two-factor-set-up-steps');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.requestSubmit();
  });
}

describe('two-factor setup status', () => {
  it('says Off only before setup starts, and only that it is on once confirmed', async () => {
    const setUp = { otpauthUrl: 'otpauth://totp/x', setupKey: 'KEY', qrSvg: null, backupCodes: ['aaaa-bbbb'] };
    act(() =>
      root.render(
        <TwoFactorSetUpSteps
          intro={<p>Off. Turn it on.</p>}
          start={async () => ({ ok: true, setUp })}
          confirm={async () => ({ ok: true })}
          continueHref="/acme/security"
        />,
      ),
    );
    expect(container.textContent).toContain('Off. Turn it on.');

    await submit();
    expect(container.textContent).toContain('Setup key: KEY');
    expect(container.textContent).not.toContain('Off.');

    (container.querySelector('input[name="code"]') as HTMLInputElement).value = '123456';
    await submit();
    expect(container.textContent).toContain('Two-factor authentication is on.');
    expect(container.textContent).not.toContain('Off.');
  });
});
