import * as React from 'react';

/**
 * A field no person sees or fills. A sign-up that arrives with it filled was a
 * bot. Its name matches no autofill heuristic: browsers and password managers
 * do not always honour `autocomplete="off"`, and one that filled a field named
 * like `website` would turn a real person's sign-up into a silent bot answer.
 */
export const SIGN_UP_HONEYPOT = 'rk_hp_7f3';

export function SignUpHoneypot(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
      <label>
        Leave this empty
        <input
          type="text"
          name={SIGN_UP_HONEYPOT}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          defaultValue=""
        />
      </label>
    </div>
  );
}
