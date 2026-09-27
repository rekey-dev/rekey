/**
 * Built-in default templates per transactional event.
 *
 * Tenants who don't customise a given event get this template at send
 * time. Editing in the panel writes an `EmailTemplate` row that overrides
 * the default for that (Application, eventKey) pair; deleting the row
 * reverts back to here. A saved row is sent exactly as saved, so a change
 * here never reaches an operator who customised the event.
 *
 * Each default is written once, as blocks, and the HTML we send, its
 * plain-text alternative and the design the panel's editor opens are all
 * built from them, with the sending Application's brand (see `brand.ts`).
 * The renderer only substitutes the variables an event registers (see
 * `events.ts`).
 */

import type { EmailEventKey } from '../events.js';
import { escapeHtml, renderSpecHtml, type EmailBlock, type EmailSpec } from './blocks.js';
import type { EmailBrand } from './brand.js';
import { renderSpecText } from './plain-text.js';
import { specToUnlayerDesign, type UnlayerDesign } from './unlayer-design.js';

export type { EmailBlock, EmailSpec } from './blocks.js';
export type { UnlayerDesign } from './unlayer-design.js';
export { brandFromApplication, SYSTEM_BRAND, type EmailBrand } from './brand.js';

export interface DefaultTemplate {
  /** Default subject with {{var}} substitution. */
  subject: string;
  /** The content the HTML, the text and the design are all built from. */
  blocks: readonly EmailBlock[];
  /** Inbox-safe HTML body. */
  html: string;
  /** Plain-text alternative, with the same {{var}} tokens. */
  text: string;
  /** The same content as an Unlayer design, for the panel's editor. */
  design: UnlayerDesign;
}

const heading = (text: string): EmailBlock => ({ kind: 'heading', text });
const p = (html: string): EmailBlock => ({ kind: 'paragraph', html });
const note = (html: string): EmailBlock => ({ kind: 'note', html });
const alert = (html: string): EmailBlock => ({ kind: 'alert', html });
const button = (hrefVar: string, label: string): EmailBlock => ({ kind: 'button', hrefVar, label });
const divider: EmailBlock = { kind: 'divider' };

const NOT_YOU =
  "<strong>Didn't do this?</strong> Someone else may have access to your account. Reset your password right away and contact support.";

/**
 * Each event's copy, given the brand's name. `name` is for subjects and
 * preheaders, which are plain text; `html` is the same name escaped for the
 * blocks.
 */
type Copy = (name: { text: string; html: string }) => EmailSpec;

const CONTENT: Record<EmailEventKey, Copy> = {
  password_reset: (n) => ({
    subject: `Reset your ${n.text} password`,
    preheader: 'Use this link to choose a new password. It expires in an hour.',
    blocks: [
      heading('Reset your password'),
      p(`Someone asked to reset the password for the ${n.html} account <strong>{{userEmail}}</strong>. Choose a new one with the button below.`),
      button('resetUrl', 'Reset password'),
      note('This link expires at {{expiresAt}}.'),
      divider,
      note("If you didn't ask to reset your password, you can safely ignore this email. Your password won't change."),
    ],
    reason: `a password reset was requested for your ${n.html} account.`,
  }),
  email_verification: (n) => ({
    subject: `Confirm your email for ${n.text}`,
    preheader: 'Confirm your email address to finish setting up your account.',
    blocks: [
      heading('Confirm your email address'),
      p(`Confirm that <strong>{{userEmail}}</strong> is your email address to finish setting up your ${n.html} account.`),
      button('verifyUrl', 'Confirm email'),
      note('This link expires at {{expiresAt}}.'),
      divider,
      note(`If you didn't sign up for ${n.html}, you can safely ignore this email.`),
    ],
    reason: `this address was used to sign up for ${n.html}.`,
  }),
  magic_link_signin: (n) => ({
    subject: `Your sign-in link for ${n.text}`,
    preheader: 'Use this link to sign in. It works once and expires in 15 minutes.',
    blocks: [
      heading(`Sign in to ${n.html}`),
      p('Use the button below to sign in as <strong>{{userEmail}}</strong>. No password needed.'),
      button('signInUrl', 'Sign in'),
      note('This link expires at {{expiresAt}} and can only be used once.'),
      divider,
      note("If you didn't try to sign in, you can safely ignore this email. Nobody can sign in without this link."),
    ],
    reason: `someone asked to sign in to ${n.html} with this email address.`,
  }),
  workspace_invitation: (n) => ({
    subject: `{{inviterName}} invited you to {{workspaceName}} on ${n.text}`,
    preheader: 'Accept the invitation to join the {{workspaceName}} workspace.',
    blocks: [
      heading('Join {{workspaceName}}'),
      p(`<strong>{{inviterName}}</strong> invited you to join the <strong>{{workspaceName}}</strong> workspace on ${n.html}.`),
      button('inviteUrl', 'Accept invitation'),
      note('This invitation was sent to {{inviteeEmail}} and expires at {{expiresAt}}.'),
      divider,
      note("If you weren't expecting this invitation, you can safely ignore this email."),
    ],
    reason: `{{inviterName}} invited this address to a workspace on ${n.html}.`,
  }),
  welcome: (n) => ({
    subject: `Welcome to ${n.text}`,
    preheader: 'Your account is ready.',
    blocks: [
      heading(`Welcome to ${n.html}`),
      p('Thanks for signing up. Your account for <strong>{{userEmail}}</strong> is ready to use.'),
      button('appUrl', 'Get started'),
    ],
    reason: `you signed up for ${n.html} with this email address.`,
  }),
  mfa_enabled: (n) => ({
    subject: `Two-factor authentication is on for your ${n.text} account`,
    preheader: 'Signing in now also asks for a code from your authenticator app.',
    blocks: [
      heading('Two-factor authentication is on'),
      p(`Two-factor authentication was turned on for the ${n.html} account <strong>{{userEmail}}</strong> at {{enabledAt}}.`),
      p('From now on, signing in also asks for a code from your authenticator app. If this was you, there is nothing else to do.'),
      alert(NOT_YOU),
    ],
    reason: `a security setting changed on your ${n.html} account.`,
  }),
  password_changed: (n) => ({
    subject: `Your ${n.text} password was changed`,
    preheader: 'If this was you, there is nothing else to do.',
    blocks: [
      heading('Your password was changed'),
      p(`The password for the ${n.html} account <strong>{{userEmail}}</strong> was changed at {{changedAt}}.`),
      p('Other signed-in sessions were signed out. If this was you, there is nothing else to do.'),
      alert(NOT_YOU),
    ],
    reason: `a security setting changed on your ${n.html} account.`,
  }),
  billing_payment_failed_reminder: (n) => ({
    subject: `Action needed: your ${n.text} payment failed`,
    preheader: 'Update your payment method to keep your {{planName}} subscription.',
    blocks: [
      heading("Your payment didn't go through"),
      p(`We couldn't collect the payment for your ${n.html} subscription. We'll try again automatically, but please check that your payment method is up to date and has enough funds.`),
      {
        kind: 'details',
        rows: [
          { label: 'Plan', html: '{{planName}}' },
          { label: 'Amount due', html: '<strong>{{amountDue}}</strong>' },
          { label: 'Canceled if unpaid by', html: '{{graceEndsAt}}' },
        ],
      },
      // Guarded like every button: an Application without the hosted portal
      // passes an empty portalUrl and the mail keeps the text above only.
      button('portalUrl', 'Update payment method'),
      divider,
      note("This is reminder {{attempt}}. If you've already updated your payment details, you can ignore this email."),
    ],
    reason: `you have a {{planName}} subscription with ${n.html}.`,
  }),
  // The one operator-addressed template here. It reports money received that
  // Rekey could not match to anything, so it names an amount and asks for a
  // decision rather than reassuring anybody. No CTA button: the action lives
  // behind an operator sign-in and a dead-ended link in a mail about missing
  // money would be worse than none.
  billing_unapplied_payment: (n) => ({
    subject: 'Unapplied payment: {{amount}} received with nothing to apply it to',
    preheader: '{{amount}} arrived at {{provider}} and matches no subscription. Decide what happens to it.',
    blocks: [
      heading('A payment arrived that could not be applied'),
      p("<strong>{{amount}}</strong> was captured at <strong>{{provider}}</strong>, but it doesn't match any subscription in your application. The money is with your payment provider and nothing has been refunded."),
      {
        kind: 'details',
        rows: [
          { label: 'Amount', html: '<strong>{{amount}}</strong>' },
          { label: 'Customer', html: '{{endUserEmail}}' },
          { label: 'Provider', html: '{{provider}}' },
          { label: 'Payment ID', html: '{{providerPaymentId}}', mono: true },
          { label: 'Received', html: '{{receivedAt}}' },
        ],
      },
      p('This usually means a checkout completed at the provider after it had stopped being waited for. The customer has most likely paid for something they expect to receive.'),
      p(`Open <strong>Billing, Unapplied payments</strong> in your ${n.html} dashboard to refund it, or to keep the money and extend the customer's access instead.`),
      alert(`${n.html} will not refund this on its own. Left unresolved, a customer who paid and received nothing is likely to raise a chargeback rather than ask.`),
    ],
    reason: `you are an owner or admin of the workspace on ${n.html} that received this payment.`,
  }),
};

/**
 * The default template for an event, in a brand.
 *
 * @example
 * const tpl = defaultTemplate('password_reset', brandFromApplication(app));
 * tpl.subject; // 'Reset your Acme password'
 */
export function defaultTemplate(eventKey: EmailEventKey, brand: EmailBrand): DefaultTemplate {
  const spec = CONTENT[eventKey]({ text: brand.name, html: escapeHtml(brand.name) });
  return {
    subject: spec.subject,
    blocks: spec.blocks,
    html: renderSpecHtml(spec, brand),
    text: renderSpecText(spec, brand),
    design: specToUnlayerDesign(spec, brand),
  };
}
