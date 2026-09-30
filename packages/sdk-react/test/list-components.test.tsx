/**
 * List forms: <NewsletterForm>, <ContactForm> and useListSubscribe. The
 * browser path loads the list with the publishable key and posts the
 * subscribe; the Server Action path posts the documented field names.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContactListPublicDto } from '@rekey.dev/shared-types';
import { RekeyProvider } from '../src/context.js';
import { ContactForm, NewsletterForm } from '../src/list-components.js';

const WAITLIST: ContactListPublicDto = {
  key: 'waitlist',
  name: 'Waitlist',
  kind: 'waitlist',
  fieldSchema: [
    { name: 'company', label: 'Company', type: 'text', required: false, maxLength: 500 },
    { name: 'plan', label: 'Plan', type: 'select', required: true, maxLength: 500, options: ['solo', 'team'] },
    { name: 'beta', label: 'Try the beta', type: 'checkbox', required: false, maxLength: 500 },
  ],
  consent: { text: 'Email me when it launches.', version: 3, lawfulBasis: 'consent' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function withProvider(ui: React.ReactNode): React.JSX.Element {
  return (
    <RekeyProvider apiUrl="https://api.example.com" publishableKey="rp_pub_test">
      {ui}
    </RekeyProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('<NewsletterForm> in the browser', () => {
  it('loads the list, shows its consent text, and posts the consent version it was shown', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ success: true, data: WAITLIST }))
      .mockResolvedValueOnce(json({ success: true, data: { status: 'received' } }, 202));
    render(withProvider(<NewsletterForm list="waitlist" title="Join" />));

    expect(await screen.findByText('Email me when it launches.')).not.toBeNull();
    expect(screen.queryByLabelText('Company')).toBeNull();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByRole('button', { name: 'Subscribe' }).closest('form')!);

    expect(await screen.findByText('Thanks. You are on the list.')).not.toBeNull();
    const [getUrl, getInit] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(getUrl).toBe('https://api.example.com/api/v1/lists/waitlist');
    expect((getInit.headers as Record<string, string>).Authorization).toBe('Bearer rp_pub_test');
    const [postUrl, postInit] = fetchSpy.mock.calls[1]! as [string, RequestInit];
    expect(postUrl).toBe('https://api.example.com/api/v1/lists/waitlist/subscribe');
    const body = JSON.parse(postInit.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ email: 'ada@example.com', consent: { granted: true, version: 3 } });
    expect(body).not.toHaveProperty('hp');
  });

  it("shows the API's refusal instead of claiming success", async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ success: true, data: WAITLIST }))
      .mockResolvedValueOnce(
        json(
          { success: false, error: { code: 'CONTACTS_RATE_LIMITED', message: 'Too many subscribes from this address.' } },
          429,
        ),
      );
    render(withProvider(<NewsletterForm list="waitlist" />));
    await screen.findByText('Email me when it launches.');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Subscribe' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many subscribes from this address.');
  });
});

describe('<ContactForm>', () => {
  it('renders the list fields and posts typed values, a hidden honeypot included', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ success: true, data: { status: 'received' } }, 202));
    render(withProvider(<ContactForm list="waitlist" form={WAITLIST} />));
    expect(document.querySelector('input[name="hp"]')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Engines' } });
    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'team' } });
    fireEvent.click(screen.getByLabelText('Try the beta'));
    fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.fields).toEqual({ company: 'Engines', plan: 'team', beta: true });
  });

  it('with a Server Action and the form, renders without a RekeyProvider', () => {
    render(<NewsletterForm list="waitlist" form={WAITLIST} action={vi.fn()} />);
    expect(screen.getByText('Email me when it launches.')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('with a Server Action, posts to it and never calls the API from the browser', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const action = vi.fn();
    render(withProvider(<ContactForm list="waitlist" form={WAITLIST} action={action} />));
    const form = screen.getByRole('button', { name: 'Send' }).closest('form')!;
    const names = Array.from(form.elements)
      .map((el) => (el as HTMLInputElement).name)
      .filter(Boolean);
    expect(names).toEqual(['email', 'company', 'plan', 'beta', 'consent', 'consentVersion', 'hp']);
    expect((form.querySelector('input[name="consentVersion"]') as HTMLInputElement).value).toBe('3');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
