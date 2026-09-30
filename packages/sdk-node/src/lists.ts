import type {
  ContactListPublicDto,
  ContactListSummaryDto,
  ListMemberDto,
  ListMemberStatus,
  ListMembersPage,
  ListSubscribeOutcome,
  ListSubscribeReceived,
  ListSubscribeRequest,
} from '@rekey.dev/shared-types';
import type { Rekey } from './index.js';

/** Options for {@link ListsClient.subscribe}. */
export interface ListSubscribeOptions {
  /**
   * `'browser'` when this call passes on a visitor's form. Sent as
   * `X-Rekey-Relay: browser`, it makes the API apply the browser rules even if
   * the visitor address is missing, so a relay can never act as your server.
   */
  relay?: 'browser';
}

/** Filters for {@link ListsClient.members}. */
export interface ListMembersOptions {
  /** `subscribed` (default), `unsubscribed`, or `all` to hear about unsubscribes too. */
  status?: ListMemberStatus | 'all';
  /** Only members changed after this. Pass the last `updatedAt` you stored. */
  updatedSince?: Date | string;
  /** `nextCursor` from the previous page. */
  cursor?: string;
  /** 1 to 500, default 100. */
  limit?: number;
}

function query(options: ListMembersOptions): string {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.updatedSince) {
    params.set(
      'updatedSince',
      typeof options.updatedSince === 'string' ? options.updatedSince : options.updatedSince.toISOString(),
    );
  }
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const path = (key: string) => `/api/v1/lists/${encodeURIComponent(key)}`;

/**
 * Lists: a waitlist, a newsletter or a contact form that stores people who
 * have no account. Create lists in the panel (Lists), then subscribe people
 * from your server. Rekey sends no email to a list: read the members out with
 * {@link ListsClient.members} and hand them to your email tool.
 */
export class ListsClient {
  constructor(private readonly client: Rekey) {}

  /**
   * Every list of this Application with its member counts. Archived lists are
   * included and flagged. Needs `contacts:write`, which `*` keys hold.
   *
   * @example
   * ```ts
   * for (const list of await rekey.lists.list()) console.log(list.key, list.subscribed);
   * ```
   */
  async list(): Promise<ContactListSummaryDto[]> {
    return (await this.client.send<{ items: ContactListSummaryDto[] }>('GET', '/api/v1/lists')).items;
  }

  /**
   * A list's form: its extra fields, and the consent text and version to show.
   *
   * @example
   * ```ts
   * const list = await rekey.lists.get('waitlist');
   * // render list.consent.text next to a checkbox, then send list.consent.version back
   * ```
   */
  get(key: string): Promise<ContactListPublicDto> {
    return this.client.send('GET', path(key));
  }

  /**
   * Add someone to a list. Needs `contacts:write`, which `*` keys hold.
   *
   * Called for your own purposes (no visitor address), it resolves with what
   * happened: `subscribed`, `already_subscribed`, `previously_unsubscribed`
   * (they left; send `consent` to add them back), `suppressed` (nothing
   * stored) or `ignored` (the honeypot `hp` was filled).
   *
   * When the call relays a visitor's form, pass their address with
   * `rekey.with({ clientIp })` and `{ relay: 'browser' }`. The API then treats
   * it as that browser: its limits apply, it cannot add back someone who left
   * or rename a contact, and it always resolves `{ status: 'received' }`. Pass
   * that on as it is.
   *
   * @example
   * ```ts
   * await rekey.with({ clientIp: visitorIp }).lists.subscribe(
   *   'waitlist',
   *   { email: 'ada@example.com', consent: { granted: true, version: 1 } },
   *   { relay: 'browser' },
   * );
   * ```
   */
  subscribe(
    key: string,
    input: ListSubscribeRequest,
    options: ListSubscribeOptions = {},
  ): Promise<ListSubscribeOutcome | ListSubscribeReceived> {
    const headers = options.relay === 'browser' ? { 'X-Rekey-Relay': 'browser' } : undefined;
    return this.client.send('POST', `${path(key)}/subscribe`, input, headers);
  }

  /**
   * One page of a list's members, oldest change first. Needs a key minted
   * with the elevated `contacts:read` scope; `*` does not include it.
   *
   * @example
   * ```ts
   * const { items, nextCursor } = await rekey.lists.members('waitlist', { limit: 200 });
   * ```
   */
  members(key: string, options: ListMembersOptions = {}): Promise<ListMembersPage> {
    return this.client.send('GET', `${path(key)}/members${query(options)}`);
  }

  /**
   * Every member, following cursors for you. Store the last `updatedAt` you
   * see and pass it as `updatedSince` next time to sync only what changed.
   *
   * @example
   * ```ts
   * for await (const member of rekey.lists.iterateMembers('waitlist', { status: 'all', updatedSince })) {
   *   await emailTool.upsert(member.email, member.status);
   * }
   * ```
   */
  async *iterateMembers(key: string, options: Omit<ListMembersOptions, 'cursor'> = {}): AsyncGenerator<ListMemberDto> {
    let cursor: string | undefined;
    do {
      const page = await this.members(key, { ...options, ...(cursor !== undefined && { cursor }) });
      yield* page.items;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  /**
   * Take someone off a list, for example when your email tool reports an
   * unsubscribe. Idempotent. Needs `contacts:write`.
   *
   * @example
   * ```ts
   * await rekey.lists.unsubscribe('newsletter', 'ada@example.com');
   * ```
   */
  unsubscribe(key: string, email: string): Promise<{ status: 'unsubscribed' | 'not_subscribed' }> {
    return this.client.send('DELETE', `${path(key)}/members/${encodeURIComponent(email)}`);
  }
}
