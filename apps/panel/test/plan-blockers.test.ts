/**
 * When the plans page offers Register on a plan that cannot be bought.
 *
 * Register re-runs the plan's registration with the payment provider. It was
 * offered on a plan whose only problem was that no provider can charge its
 * currency, where pressing it could only come back with an error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { PlanBlocker } from '@/lib/api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { panelRepair, registerCanHelp, repairText, settledElsewhere } from '@/lib/plan-blockers';
import { PlanBlockers } from '@/app/(authed)/applications/[id]/plans/PlanBlockers';

vi.mock('@/components/Link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement('a', { href }, children as never),
}));

const blocker = (code: string, provider: string | null = null): PlanBlocker => ({
  provider,
  code,
  message: `${code} message`,
  fix: `${code} fix`,
});

const NO_PROVIDER = blocker('NO_BILLING_PROVIDER');
const CURRENCY = blocker('PLAN_CURRENCY_UNSUPPORTED');
const UNREGISTERED = blocker('PLAN_NOT_REGISTERED', 'stripe');

describe('registerCanHelp', () => {
  it('is withheld when no provider is connected', () => {
    expect(registerCanHelp([NO_PROVIDER])).toBe(false);
    expect(registerCanHelp([NO_PROVIDER, UNREGISTERED])).toBe(false);
  });

  it('is withheld when the only blocker is a currency no provider can charge', () => {
    expect(registerCanHelp([CURRENCY])).toBe(false);
  });

  it('is offered when registering clears at least one blocker', () => {
    expect(registerCanHelp([UNREGISTERED])).toBe(true);
    expect(registerCanHelp([CURRENCY, UNREGISTERED])).toBe(true);
  });

  it('is offered for an unbuyable plan that lists no blocker', () => {
    expect(registerCanHelp([])).toBe(true);
  });
});

describe('settledElsewhere', () => {
  it('returns the blockers Register cannot clear, with their own fix text', () => {
    expect(settledElsewhere([CURRENCY, UNREGISTERED, NO_PROVIDER])).toEqual([CURRENCY, NO_PROVIDER]);
    expect(settledElsewhere([CURRENCY])[0]!.fix).toBe('PLAN_CURRENCY_UNSUPPORTED fix');
    expect(settledElsewhere([UNREGISTERED])).toEqual([]);
  });
});

describe('panelRepair', () => {
  const API_FIX = 'Fix whatever Stripe objected to, then POST /api/v1/tenant/applications/app_1/plans/pro/register to retry.';
  const failed: PlanBlocker = { provider: 'stripe', code: 'PLAN_REGISTRATION_FAILED', message: 'Stripe refused the plan.', fix: API_FIX };

  it('leads a failed registration with the panel action and the register control, and names no route', () => {
    const repair = panelRepair(failed, 'app_1')!;
    expect(repair.action).toContain("Fix the provider's credentials under Billing, Setup, Providers");
    expect(repair.action).toContain('press Retry registration');
    expect(repair.action).not.toMatch(/POST|\/api\//);
    expect(repair.link).toEqual({ href: '/applications/app_1/billing/providers', label: 'Billing, Setup, Providers' });
    expect(repair.register).toBe('Retry registration');
  });

  it('offers Register for a plan that was never registered, and the providers page where registering cannot help', () => {
    expect(panelRepair(UNREGISTERED, 'app_1')).toMatchObject({ register: 'Register', link: null });
    for (const blocker of [NO_PROVIDER, CURRENCY]) {
      const repair = panelRepair(blocker, 'app_1')!;
      expect(repair.register, blocker.code).toBeNull();
      expect(repair.link?.href, blocker.code).toBe('/applications/app_1/billing/providers');
    }
  });

  it('offers a register control exactly where Register can clear the blocker', () => {
    for (const blocker of [failed, UNREGISTERED, NO_PROVIDER, CURRENCY]) {
      expect(panelRepair(blocker, 'app_1')!.register !== null, blocker.code).toBe(registerCanHelp([blocker]));
    }
  });

  it('has no action for a code it does not know, so the fix the API gave is what is shown', () => {
    const trial = blocker('PLAN_TRIAL_UNSUPPORTED', 'razorpay');
    expect(panelRepair(trial, 'app_1')).toBeNull();
    expect(repairText(trial, 'app_1')).toBe('PLAN_TRIAL_UNSUPPORTED fix');
    expect(repairText(failed, 'app_1')).toBe(panelRepair(failed, 'app_1')!.action);
  });

  it('writes no em dash', () => {
    for (const code of ['PLAN_REGISTRATION_FAILED', 'PLAN_NOT_REGISTERED', 'NO_BILLING_PROVIDER', 'PLAN_CURRENCY_UNSUPPORTED']) {
      expect(panelRepair(blocker(code), 'app_1')!.action).not.toContain(String.fromCharCode(0x2014));
    }
  });

  describe('in the plan dialog', () => {
    const render = (blockers: PlanBlocker[]): string =>
      renderToStaticMarkup(
        createElement(PlanBlockers, {
          blockers,
          applicationId: 'app_1',
          providerLabel: (name: string) => name.toUpperCase(),
          register: (label: string) => createElement('button', { type: 'submit' }, label),
        }),
      );

    it('leads with the panel action, puts the register control beside it, and keeps the fix of the API behind a disclosure', () => {
      const html = render([failed]);
      const action = html.indexOf('press Retry registration');
      const disclosure = html.indexOf('<details');
      expect(action).toBeGreaterThan(-1);
      expect(disclosure).toBeGreaterThan(action);
      expect(html).toContain('<button type="submit">Retry registration</button>');
      expect(html).toContain('href="/applications/app_1/billing/providers"');
      expect(html).toContain('How to do this over the API');
      // Only inside the disclosure.
      expect(html.indexOf('POST /api/v1/tenant/applications/app_1/plans/pro/register')).toBeGreaterThan(disclosure);
    });

    it('shows the fix of the API as the repair for a code with no panel action, with no disclosure and no control', () => {
      const html = render([blocker('PLAN_TRIAL_UNSUPPORTED', 'razorpay')]);
      expect(html).toContain('To repair: </span>PLAN_TRIAL_UNSUPPORTED fix');
      expect(html).not.toContain('<details');
      expect(html).not.toContain('<button');
    });
  });
});

describe('the blocker type', () => {
  it('is the one the API client declares, not a second copy', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/lib/plan-blockers.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/import type \{ PlanBlocker \} from '\.\/api';/);
    expect(source).not.toMatch(/\b(interface|type) PlanBlocker\b/);
  });
});
