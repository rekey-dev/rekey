/**
 * Retries per "Retry all failed" click. Each one is a request against the
 * operator's API budget, so a click must leave room for the rest of the panel.
 * The banner offers the next batch.
 */
export const RETRY_ALL_CAP = 100;
