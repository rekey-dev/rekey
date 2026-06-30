/**
 * Auth widgets — <SignIn>, <SignUp>, <UserButton>, and the nav buttons.
 *
 * These are "render + delegate": they render forms wired to the integrator's
 * Server Actions, never calling the API themselves. So the contract we pin is
 * structural + accessible:
 *   - inputs are labelled and named the way the documented actions read them
 *     (email/password), with proper autoComplete;
 *   - OAuth providers and error banners render with the right roles;
 *   - <UserButton> renders nothing signed-out, and signed-in exposes an
 *     accessible menu button + a sign-out affordance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { authState, setAuth, signedIn, signedOut, loading } from './helpers';

vi.mock('../src/hooks.js', () => ({
  useUser: () => ({ user: authState.user, signedIn: authState.signedIn, loading: authState.loading }),
}));

import {
  SignIn,
  SignUp,
  UserButton,
  SignInButton,
  SignUpButton,
  SignOutButton,
} from '../src/auth-components.js';

const noop = vi.fn();

beforeEach(() => setAuth({}));

describe('<SignIn>', () => {
  it('renders labelled, named email + password inputs with proper autocomplete', () => {
    const { container } = render(<SignIn action={noop} />);
    const email = container.querySelector('#relipay-signin-email') as HTMLInputElement;
    const pw = container.querySelector('#relipay-signin-password') as HTMLInputElement;
    expect(email.name).toBe('email');
    expect(email.type).toBe('email');
    expect(email.autocomplete).toBe('email');
    expect(pw.name).toBe('password');
    expect(pw.type).toBe('password');
    expect(pw.autocomplete).toBe('current-password');
    // Each input is associated with a <label for=…>.
    expect(container.querySelector('label[for="relipay-signin-email"]')).not.toBeNull();
    expect(container.querySelector('label[for="relipay-signin-password"]')).not.toBeNull();
  });

  it('renders the magic-link form only when a magic-link action/url is given', () => {
    const { container, rerender } = render(<SignIn action={noop} />);
    // Without it: a single form (password).
    expect(container.querySelectorAll('form').length).toBe(1);
    rerender(<SignIn action={noop} magicLinkAction={noop} />);
    expect(container.querySelectorAll('form').length).toBe(2);
    expect(screen.getByRole('button', { name: /email link/i })).not.toBeNull();
    // The magic-link email input (placeholder-only) carries an accessible name.
    expect(screen.getByRole('textbox', { name: /email for magic link/i })).not.toBeNull();
  });

  it('renders OAuth provider buttons with a sensible default label', () => {
    render(<SignIn action={noop} oauthProviders={[{ provider: 'google', startUrl: '/oauth/google' }]} />);
    expect(screen.getByText(/continue with google/i)).not.toBeNull();
  });

  it('surfaces an error message in an alert region', () => {
    render(<SignIn action={noop} error="Invalid credentials" />);
    expect(screen.getByRole('alert').textContent).toContain('Invalid credentials');
  });

  it('renders sign-up + forgot-password links when their URLs are set', () => {
    render(<SignIn action={noop} signUpUrl="/signup" forgotPasswordUrl="/forgot" />);
    expect(screen.getByText('Create account').getAttribute('href')).toBe('/signup');
    expect(screen.getByText('Forgot password?').getAttribute('href')).toBe('/forgot');
  });
});

describe('<SignUp>', () => {
  it('uses new-password autocomplete on the password field', () => {
    const { container } = render(<SignUp action={noop} />);
    const pw = container.querySelector('#relipay-signup-password') as HTMLInputElement;
    expect(pw.autocomplete).toBe('new-password');
  });

  it('renders the sign-in link when signInUrl is provided', () => {
    render(<SignUp action={noop} signInUrl="/login" />);
    expect(screen.getByText('Sign in').getAttribute('href')).toBe('/login');
  });
});

describe('<UserButton>', () => {
  it('renders nothing when signed out', () => {
    signedOut();
    const { container } = render(<UserButton signOutAction={noop} />);
    expect(container.querySelector('.relipay-userbtn')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders nothing while loading', () => {
    loading();
    const { container } = render(<UserButton signOutAction={noop} />);
    expect(container.textContent).toBe('');
  });

  it('renders an accessible avatar menu button when signed in', () => {
    signedIn();
    render(<UserButton signOutAction={noop} />);
    const btn = screen.getByRole('button', { name: /account menu/i });
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // Avatar shows the email initial (jane@ → "J").
    expect(btn.textContent).toBe('J');
  });

  it('opens a menu exposing the email and a sign-out item on click', () => {
    signedIn();
    render(<UserButton signOutAction={noop} manageAccountUrl="/account" />);
    const btn = screen.getByRole('button', { name: /account menu/i });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('jane@example.com')).not.toBeNull();
    expect(within(menu).getByText('Manage account').getAttribute('href')).toBe('/account');
    expect(within(menu).getByText('Sign out')).not.toBeNull();
  });

  it('renders the sign-out as a form submit when given a signOutAction', () => {
    signedIn();
    render(<UserButton signOutAction={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
    const signOut = screen.getByText('Sign out');
    // It is inside a <form> and is a submit button (server-action delegation).
    expect(signOut.closest('form')).not.toBeNull();
    expect((signOut as HTMLButtonElement).type).toBe('submit');
  });
});

describe('nav buttons', () => {
  it('<SignInButton> navigates to the given url', () => {
    render(<SignInButton url="/login" />);
    expect(screen.getByText('Sign in').getAttribute('href')).toBe('/login');
  });

  it('<SignUpButton> falls back to a "Sign up" label', () => {
    render(<SignUpButton url="/signup" />);
    expect(screen.getByText('Sign up').getAttribute('href')).toBe('/signup');
  });

  it('<SignOutButton> renders a form submit when given an action', () => {
    render(<SignOutButton action={noop} />);
    const btn = screen.getByRole('button', { name: /sign out/i });
    expect(btn.getAttribute('type')).toBe('submit');
    expect(btn.closest('form')).not.toBeNull();
  });

  it('honours a custom child label', () => {
    render(<SignInButton url="/login">Log in now</SignInButton>);
    expect(screen.getByText('Log in now')).not.toBeNull();
  });
});
