import { describe, it, expect } from 'vitest';
import { modalFlag, modalFlagValue, shouldReopen } from '@/lib/modal-reopen';

/**
 * Regression cover for a silent-failure class found by driving the panel:
 * a modal-hosted form whose server action failed, redirected back with a flag
 * the modal did not recognise, so the modal stayed shut — and since the error
 * renders inside the `<dialog>`, a shut dialog renders nothing at all. Editing
 * an end-user with malformed metadata, or deleting a held role, produced a page
 * navigation with no message anywhere on screen.
 */

const search = (qs: string): URLSearchParams => new URLSearchParams(qs);

describe('modalFlagValue', () => {
  it('defaults to "1" for a page with a single modal of its kind', () => {
    expect(modalFlagValue()).toBe('1');
    expect(modalFlagValue(undefined)).toBe('1');
  });

  it('uses the row identifier when one modal is rendered per row', () => {
    expect(modalFlagValue('cmsb123')).toBe('cmsb123');
  });
});

describe('modalFlag', () => {
  it('builds the querystring fragment an action appends on failure', () => {
    expect(modalFlag('newWebhook')).toBe('newWebhook=1');
    expect(modalFlag('editUser', 'cmsb123')).toBe('editUser=cmsb123');
  });

  it('percent-encodes a value that is not URL-safe', () => {
    // Role names reach the flag verbatim (`?deleteRole=<name>`).
    expect(modalFlag('deleteRole', 'team lead')).toBe('deleteRole=team%20lead');
  });

  it('round-trips through URLSearchParams back into shouldReopen', () => {
    const params = search(modalFlag('deleteRole', 'team lead'));
    expect(shouldReopen(params, 'deleteRole', 'team lead')).toBe(true);
  });
});

describe('shouldReopen', () => {
  it('reopens the single modal whose flag is set', () => {
    expect(shouldReopen(search('error=WEBHOOK_URL_UNSAFE&newWebhook=1'), 'newWebhook')).toBe(true);
  });

  it('leaves other modals on the page shut', () => {
    const params = search('error=missing&newWebhook=1');
    expect(shouldReopen(params, 'newKey')).toBe(false);
  });

  it('reopens only the row that failed', () => {
    const params = search('error=metadata_invalid_json&editUser=user-b');
    expect(shouldReopen(params, 'editUser', 'user-b')).toBe(true);
    expect(shouldReopen(params, 'editUser', 'user-a')).toBe(false);
    expect(shouldReopen(params, 'editUser', 'user-c')).toBe(false);
  });

  it('does not reopen a per-row modal on the bare "1" flag', () => {
    // A value-carrying modal must not answer a flag meant for a singleton.
    expect(shouldReopen(search('editUser=1'), 'editUser', 'user-a')).toBe(false);
  });

  it('does not treat a row id as the singleton flag', () => {
    expect(shouldReopen(search('editUser=user-a'), 'editUser')).toBe(false);
  });

  it('stays shut when no flag is present', () => {
    expect(shouldReopen(search('error=BAD_REQUEST'), 'newWebhook')).toBe(false);
    expect(shouldReopen(search(''), 'editUser', 'user-a')).toBe(false);
  });

  it('stays shut for a modal that opted out of reopen-on-error', () => {
    expect(shouldReopen(search('error=X&newPlan=1'), undefined)).toBe(false);
  });

  it('rejects the encode-the-row-into-the-key shape that caused the bug', () => {
    // The action set `?editUser=<id>`; the modal declared the key
    // `editUser_<id>`. The lookup missed, so nothing reopened and nothing was
    // shown. Both spellings must stay false against each other's flag.
    const actionFlag = search('error=metadata_invalid_json&editUser=user-a');
    expect(shouldReopen(actionFlag, 'editUser_user-a')).toBe(false);
    expect(shouldReopen(actionFlag, 'editUser_user-a', 'user-a')).toBe(false);
    // The shape actually shipped works.
    expect(shouldReopen(actionFlag, 'editUser', 'user-a')).toBe(true);
  });
});
