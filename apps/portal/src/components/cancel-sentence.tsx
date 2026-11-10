/**
 * The sentence under a renewal: how this buyer can cancel, through the first
 * route that exists. Shared by the checkout page and the portal's plan review,
 * so a buyer reads the same promise on both.
 */

import * as React from 'react';

export function CancelSentence({
  manageHref,
  supportUrl,
  supportEmail,
  merchantName,
  linkClassName,
}: {
  /** Where the buyer manages the subscription, already checked as safe. */
  manageHref: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  merchantName: string;
  linkClassName: string;
}): React.JSX.Element {
  if (manageHref) {
    return (
      <>
        You can cancel any time from{' '}
        <a className={linkClassName} href={manageHref}>
          your account
        </a>
        ; canceling stops the next renewal.
      </>
    );
  }
  if (supportUrl) {
    return (
      <>
        You can cancel any time by contacting{' '}
        <a className={linkClassName} href={supportUrl}>
          {merchantName} support
        </a>
        ; canceling stops the next renewal.
      </>
    );
  }
  if (supportEmail) {
    return (
      <>
        You can cancel any time by emailing{' '}
        <a className={`${linkClassName} [overflow-wrap:anywhere]`} href={`mailto:${supportEmail}`}>
          {supportEmail}
        </a>
        ; canceling stops the next renewal.
      </>
    );
  }
  return <>You can cancel any time from your {merchantName} account; canceling stops the next renewal.</>;
}
