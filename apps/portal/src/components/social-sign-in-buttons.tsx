import * as React from 'react';
import type { OAuthProviderSummaryDto } from '@rekey.dev/shared-types';
import { startSocialSignInAction } from '@/lib/social-sign-in-actions';
import { SubmitButton } from './submit-button';

/** One button per provider the application offers, in the API's order, named as the API names them. */
export function SocialSignInButtons({
  slug,
  providers,
  returnTo,
  separated,
}: {
  slug: string;
  providers: OAuthProviderSummaryDto[];
  returnTo: string | null;
  /** Draw a rule above the buttons, when another way in sits above them. */
  separated: boolean;
}): React.JSX.Element | null {
  if (providers.length === 0) return null;
  return (
    <div className={separated ? 'space-y-3 border-t border-[var(--color-border)] pt-5' : 'space-y-3'}>
      {providers.map((provider) => (
        <form key={provider.id} action={startSocialSignInAction.bind(null, slug, provider.id)}>
          {returnTo && <input type="hidden" name="return" value={returnTo} />}
          <SubmitButton pendingLabel={`Opening ${provider.name}…`} variant="secondary" className="w-full">
            Continue with {provider.name}
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}
