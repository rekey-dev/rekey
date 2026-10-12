/**
 * Reading the billing log: the query a filter form turns into, and one page
 * of entries checked against the API's own schema.
 *
 * Entries are parsed one at a time. The schema is a strict union on `type`,
 * so an event type this panel build has not heard of would otherwise fail the
 * whole page; it is listed as an entry the panel cannot describe instead.
 */

import {
  BILLING_EVENT_TYPES,
  BillingLogActorsSchema,
  BillingLogEntrySchema,
  type BillingEventType,
  type BillingLogEndUser,
  type BillingLogEntry,
  type BillingLogOperator,
} from '@rekey.dev/shared-types';
import { typesInGroups, type EventGroup } from './billing-events';

export type LogView = 'activity' | 'configuration' | 'diagnostics' | 'all';

/** Which groups each view lists. Money and refusals are what an operator opens the log for. */
const VIEW_GROUPS: Record<Exclude<LogView, 'all'>, EventGroup[]> = {
  activity: ['money', 'refusal'],
  configuration: ['configuration'],
  diagnostics: ['diagnostic'],
};

export const LOG_VIEWS: Array<{ value: LogView; label: string }> = [
  { value: 'activity', label: 'Money and refusals' },
  { value: 'configuration', label: 'Configuration changes' },
  { value: 'diagnostics', label: 'Diagnostics' },
  { value: 'all', label: 'Everything' },
];

export interface LogFilters {
  view: LogView;
  /** One event type. Overrides `view`. */
  type?: BillingEventType;
  currency?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  from?: string;
  to?: string;
  endUserId?: string;
  subscriptionId?: string;
  paymentId?: string;
  cursor?: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, name: string): string | undefined {
  const value = sp[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The filters a log URL carries. Anything malformed is dropped, so a pasted
 * or edited link shows the log and not a validation error.
 *
 * @example
 * readLogFilters({ view: 'configuration', currency: 'inr' }); // { view: 'configuration', currency: 'INR' }
 */
export function readLogFilters(sp: SearchParams): LogFilters {
  const view = LOG_VIEWS.find((entry) => entry.value === one(sp, 'view'))?.value ?? 'activity';
  const type = one(sp, 'type');
  const currency = one(sp, 'currency')?.toUpperCase();
  const day = (name: string): string | undefined => {
    const value = one(sp, name);
    return value !== undefined && DAY.test(value) ? value : undefined;
  };
  const id = (name: string): string | undefined => {
    const value = one(sp, name);
    return value !== undefined && ENTITY_ID.test(value) ? value : undefined;
  };
  const cursor = one(sp, 'cursor');
  const from = day('from');
  const to = day('to');
  const endUserId = id('endUserId');
  const subscriptionId = id('subscriptionId');
  const paymentId = id('paymentId');
  return {
    view,
    ...(type !== undefined && (BILLING_EVENT_TYPES as string[]).includes(type) && { type: type as BillingEventType }),
    ...(currency !== undefined && /^[A-Z]{3}$/.test(currency) && { currency }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(endUserId !== undefined && { endUserId }),
    ...(subscriptionId !== undefined && { subscriptionId }),
    ...(paymentId !== undefined && { paymentId }),
    ...(cursor !== undefined && /^\d{1,19}$/.test(cursor) && { cursor }),
  };
}

/**
 * Whether anything beyond the view narrows the log: one event type, a
 * currency, a date, or the entity a link from another page named.
 *
 * @example
 * hasNarrowing({ view: 'configuration' }); // false
 */
export function hasNarrowing(filters: LogFilters): boolean {
  return Boolean(
    filters.type || filters.currency || filters.from || filters.to || filters.endUserId || filters.subscriptionId || filters.paymentId,
  );
}

/**
 * Whether an empty page needs one more read to be worded: the newest entry of
 * the whole log, unfiltered. Not when the page already is the whole log, and
 * not past the first page, where the log is known to have entries.
 *
 * @example
 * emptyPageNeedsWholeLogRead({ view: 'activity' }); // true
 * emptyPageNeedsWholeLogRead({ view: 'all' }); // false
 */
export function emptyPageNeedsWholeLogRead(filters: LogFilters): boolean {
  return filters.cursor === undefined && (filters.view !== 'all' || hasNarrowing(filters));
}

export interface EmptyLogState {
  title: string;
  description: string;
  /** Whether to offer the Everything view, which lists what this page leaves out. */
  offerEverything: boolean;
}

const WHAT_IS_LOGGED =
  'Entries appear here when a checkout opens, a payment is recorded, a subscription starts or a price changes. Money that moved before the log existed has no entry.';

/**
 * What an empty page of the log says. "Nothing logged yet" only when the log
 * itself is empty: a view or a filter that leaves entries out says so and
 * points at the view that lists them.
 *
 * `logHasEntries` is what the unfiltered read answered: null when it was not
 * made or failed, and then nothing is claimed about the rest of the log.
 *
 * @example
 * emptyLogState({ view: 'activity' }, true).title; // 'Nothing in this view'
 * emptyLogState({ view: 'activity' }, false).title; // 'Nothing logged yet'
 */
export function emptyLogState(filters: LogFilters, logHasEntries: boolean | null): EmptyLogState {
  if (filters.cursor !== undefined) {
    return { title: 'No older entries match these filters', description: 'Go back to the newest entries, or clear the filters.', offerEverything: false };
  }
  const wholeLog = filters.view === 'all' && !hasNarrowing(filters);
  if (wholeLog || logHasEntries === false) {
    return { title: 'Nothing logged yet', description: WHAT_IS_LOGGED, offerEverything: false };
  }
  if (hasNarrowing(filters)) {
    return {
      title: 'No entries match these filters',
      description:
        logHasEntries === true
          ? 'The log has entries these filters leave out. Try a wider date range, or show everything.'
          : 'Try a wider date range, or show everything.',
      offerEverything: true,
    };
  }
  const view = LOG_VIEWS.find((entry) => entry.value === filters.view)?.label ?? 'this view';
  return {
    title: 'Nothing in this view',
    description:
      logHasEntries === true
        ? `The log has entries in other views. "${view}" lists none of them.`
        : `"${view}" lists nothing. Other views may have entries.`,
    offerEverything: true,
  };
}

/** Every log read of the panel asks who its entries name, so a row shows an email or a name and not an id. */
export const LOG_INCLUDE = 'actors';

/**
 * The API query for a set of filters. The `to` day is inclusive on screen and
 * exclusive at the API, so it is sent as the start of the next day.
 *
 * @example
 * logQuery({ view: 'activity', to: '2026-10-12' }, 50).get('to'); // '2026-10-13T00:00:00.000Z'
 */
export function logQuery(filters: LogFilters, limit: number): URLSearchParams {
  const query = new URLSearchParams({ limit: String(limit), include: LOG_INCLUDE });
  if (filters.type !== undefined) query.set('type', filters.type);
  else if (filters.view !== 'all') query.set('type', typesInGroups(VIEW_GROUPS[filters.view]).join(','));
  if (filters.currency) query.set('currency', filters.currency);
  if (filters.from) query.set('from', `${filters.from}T00:00:00.000Z`);
  if (filters.to) query.set('to', new Date(Date.parse(`${filters.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString());
  if (filters.endUserId) query.set('endUserId', filters.endUserId);
  if (filters.subscriptionId) query.set('subscriptionId', filters.subscriptionId);
  if (filters.paymentId) query.set('paymentId', filters.paymentId);
  if (filters.cursor) query.set('cursor', filters.cursor);
  return query;
}

/** The panel URL query for a set of filters, without the cursor unless one is given. */
export function logHrefQuery(filters: LogFilters, cursor?: string | null): string {
  const query = new URLSearchParams();
  if (filters.view !== 'activity') query.set('view', filters.view);
  for (const name of ['type', 'currency', 'from', 'to', 'endUserId', 'subscriptionId', 'paymentId'] as const) {
    const value = filters[name];
    if (value !== undefined) query.set(name, value);
  }
  if (cursor) query.set('cursor', cursor);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** An entry the panel can describe, or one whose type or shape it does not know. */
export type ReadEntry =
  | { known: true; entry: BillingLogEntry }
  | { known: false; seq: string; type: string; occurredAt: string | null; raw: unknown };

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One raw log item, checked against `BillingLogEntrySchema`.
 *
 * @example
 * readEntry(item).known; // false for an event type added after this panel was built
 */
export function readEntry(raw: unknown): ReadEntry {
  const parsed = BillingLogEntrySchema.safeParse(raw);
  if (parsed.success) return { known: true, entry: parsed.data };
  const item = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    known: false,
    seq: text(item.seq) ?? '',
    type: text(item.type) ?? 'unknown',
    occurredAt: text(item.occurredAt),
    raw,
  };
}

/** Who the ids on a page are, by id. Empty where the API resolved nobody. */
export interface LogActors {
  endUsers: ReadonlyMap<string, BillingLogEndUser>;
  operators: ReadonlyMap<string, BillingLogOperator>;
}

export const NO_LOG_ACTORS: LogActors = { endUsers: new Map(), operators: new Map() };

function readLogActors(raw: unknown): LogActors {
  const parsed = BillingLogActorsSchema.safeParse(raw);
  if (!parsed.success) return NO_LOG_ACTORS;
  return {
    endUsers: new Map((parsed.data.endUsers ?? []).map((user) => [user.id, user])),
    operators: new Map(parsed.data.operators.map((operator) => [operator.id, operator])),
  };
}

export interface LogPage {
  entries: ReadEntry[];
  nextCursor: string | null;
  actors: LogActors;
}

/** A raw page from the API as entries the panel can render. */
export function readLogPage(raw: { items?: unknown; nextCursor?: unknown; actors?: unknown } | null | undefined): LogPage {
  const items = Array.isArray(raw?.items) ? (raw.items as unknown[]) : [];
  return { entries: items.map(readEntry), nextCursor: text(raw?.nextCursor), actors: readLogActors(raw?.actors) };
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** How a person an entry names is written in a row: the words shown, and whether they are an id. */
export interface PersonLabel {
  text: string;
  /** True when no name or email could be shown and `text` is the id. */
  isId: boolean;
}

/**
 * The customer of an entry: their email, "Erased end user" for one whose
 * data was erased, and the id when nobody was resolved (the end user was
 * deleted, or the reader may not read end users).
 *
 * @example
 * customerLabel(page.actors, entry.endUserId); // { text: 'buyer@example.com', isId: false }
 */
export function customerLabel(actors: LogActors, endUserId: string): PersonLabel {
  const user = actors.endUsers.get(endUserId);
  if (user?.state === 'erased') return { text: 'Erased end user', isId: false };
  if (user?.state === 'known' && user.email !== null) return { text: user.email, isId: false };
  return { text: shortId(endUserId), isId: true };
}

/**
 * The operator or end user who caused an entry, by name or email, or null
 * when the actor is the system or a provider, or nobody was resolved.
 *
 * @example
 * actorPerson(page.actors, entry.actor); // { name: 'Olga Owner', email: 'olga@example.com' }
 */
export function actorPerson(actors: LogActors, actor: BillingLogEntry['actor']): { name: string; email: string | null } | null {
  if (actor.id === null) return null;
  if (actor.type === 'operator') {
    const operator = actors.operators.get(actor.id);
    if (operator?.state !== 'known') return null;
    const name = operator.name ?? operator.email;
    return name === null ? null : { name, email: operator.name === null ? null : operator.email };
  }
  if (actor.type === 'end_user') {
    const label = customerLabel(actors, actor.id);
    return label.isId ? null : { name: label.text, email: null };
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_MAX_DAYS = 31;
export const PERIOD_DEFAULT_DAYS = 7;

export type Period = { ok: true; from: string; to: string; query: string } | { ok: false; reason: string; from: string; to: string };

/**
 * The period of the fallbacks and reconciliation views, from two day inputs.
 * The last 7 days by default, at most 31, checked here so the form says why
 * before the API refuses it.
 *
 * @example
 * readPeriod({}, new Date('2026-10-12T09:00:00Z')); // { ok: true, from: '2026-10-06', to: '2026-10-12', query: 'from=...&to=...' }
 */
export function readPeriod(sp: SearchParams, now: Date = new Date()): Period {
  const today = now.toISOString().slice(0, 10);
  const rawTo = one(sp, 'to');
  const rawFrom = one(sp, 'from');
  const to = rawTo !== undefined && DAY.test(rawTo) ? rawTo : today;
  const toStart = Date.parse(`${to}T00:00:00.000Z`);
  const from =
    rawFrom !== undefined && DAY.test(rawFrom)
      ? rawFrom
      : new Date(toStart - (PERIOD_DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const fromStart = Date.parse(`${from}T00:00:00.000Z`);
  if (Number.isNaN(fromStart) || Number.isNaN(toStart)) return { ok: false, reason: 'One of the dates is not a real day.', from, to };
  const end = toStart + DAY_MS;
  if (fromStart >= end) return { ok: false, reason: 'The period ends before it starts.', from, to };
  if (end - fromStart > PERIOD_MAX_DAYS * DAY_MS) {
    return { ok: false, reason: `A period covers at most ${PERIOD_MAX_DAYS} days. Shorten it.`, from, to };
  }
  const query = new URLSearchParams({ from: new Date(fromStart).toISOString(), to: new Date(end).toISOString() });
  return { ok: true, from, to, query: query.toString() };
}
