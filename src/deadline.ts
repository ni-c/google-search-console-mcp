/**
 * A wall-clock budget for one tool call that makes several requests.
 *
 * The 30-second timeout in `api.ts` bounds one request. It bounds nothing
 * about a call that makes fifty of them, each retried up to three times with
 * backoff in between: `submit_sitemaps` at its ceiling could hold a client for
 * the better part of two hours during an outage, with nothing to show for it
 * until the end. The budget is checked *before* each request — a request that
 * was started is finished — and a call that runs out says how far it got and
 * that the rest was not attempted, which a caller can act on.
 */
export const CALL_BUDGET_MS = 120_000;

export interface Deadline {
  /** Whether the budget is spent. Consulted before each request, never after. */
  expired(): boolean;
}

export function deadline(
  budgetMs = CALL_BUDGET_MS,
  now: () => number = Date.now
): Deadline {
  const end = now() + budgetMs;
  return { expired: () => now() >= end };
}

/** The sentence a batch tool answers with when the budget ran out. */
export function budgetNote(attempted: number, total: number): string {
  return (
    `Stopped after ${attempted} of ${total} entries: the ${Math.round(
      CALL_BUDGET_MS / 1000
    )}-second budget for one call ran out. The remaining entries were not ` +
    'attempted; call again with only those.'
  );
}
