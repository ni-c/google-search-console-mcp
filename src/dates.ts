/**
 * Relative periods the tools accept in place of two explicit dates.
 *
 * They exist because a model has no reliable calendar. Asked for "last month's
 * clicks" it will happily compute a start date from whatever it believes today
 * is, and a query that silently covers the wrong four weeks returns a perfectly
 * plausible table of wrong numbers — the worst failure this server could have.
 * Resolving the period here moves that arithmetic to the one place that knows
 * the actual date.
 *
 * `last16months` is the ceiling because that is how far Search Console retains
 * data; asking for more is not an error, it just returns nothing for the excess.
 */
export const PERIODS = [
  'today',
  'yesterday',
  'last7days',
  'last14days',
  'last28days',
  'last3months',
  'last6months',
  'last12months',
  'last16months',
] as const;

export type Period = (typeof PERIODS)[number];

/**
 * The time zone Search Console counts days in.
 *
 * Not UTC, and this is a real difference rather than a pedantic one. Search
 * Console buckets every impression by America/Los_Angeles, so between 00:00 UTC
 * and 08:00 UTC (or 07:00 in summer) "today" in UTC is still yesterday to the
 * API. A `last7days` computed in UTC would ask for a date Google has no data for
 * at all and quietly return six days.
 *
 * Documented by Google as "Pacific Time"; the IANA zone carries the daylight
 * saving rules so this stays correct across the two switches a year.
 */
export const SEARCH_CONSOLE_TIME_ZONE = 'America/Los_Angeles';

/**
 * Today's date as Search Console reckons it.
 *
 * `en-CA` is not a cosmetic choice: it is the locale whose short date format is
 * ISO 8601, so this yields `2026-08-28` directly rather than needing the parts
 * reassembled. `sv-SE` would do the same; every other common locale would not.
 */
export function todayInSearchConsole(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SEARCH_CONSOLE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Turns a period into the two dates the API wants.
 *
 * The arithmetic runs on a UTC-midnight `Date` built from the Pacific calendar
 * date, never on a local one: subtracting days from a local-midnight `Date`
 * lands on 23:00 the previous day whenever a daylight saving boundary falls in
 * the range, and `toISOString` then reports a date one day early.
 */
export function resolvePeriod(
  period: Period,
  now: Date = new Date()
): { startDate: string; endDate: string } {
  const today = todayInSearchConsole(now);

  if (period === 'today') return { startDate: today, endDate: today };
  if (period === 'yesterday') {
    const day = addDays(today, -1);
    return { startDate: day, endDate: day };
  }

  const back: Record<Exclude<Period, 'today' | 'yesterday'>, number> = {
    last7days: 7,
    last14days: 14,
    last28days: 28,
    last3months: 90,
    last6months: 180,
    last12months: 365,
    last16months: 487,
  };
  // Inclusive of both ends: `last7days` is seven days, so the start is six days
  // back, not seven. Off by one here is a whole extra day in every total.
  return {
    startDate: addDays(today, -(back[period] - 1)),
    endDate: today,
  };
}

/** A `YYYY-MM-DD` string shifted by whole days, without touching time zones. */
export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) throw new Error(`not a date: ${date}`);
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Works out the date range for a query, from whichever of the three arguments
 * were given.
 *
 * A period and an explicit date together is refused rather than silently
 * preferring one. Both spellings are things a caller meant, and picking the
 * winner for them is how a query ends up covering a range nobody asked for.
 */
export function resolveDateRange(
  input: { period?: Period; startDate?: string; endDate?: string },
  now: Date = new Date()
): { startDate: string; endDate: string } {
  const { period, startDate, endDate } = input;

  if (period !== undefined) {
    if (startDate !== undefined || endDate !== undefined) {
      throw new Error(
        `period="${period}" cannot be combined with start_date or end_date — ` +
          'give either a period or an explicit range, not both.'
      );
    }
    return resolvePeriod(period, now);
  }

  if (startDate === undefined || endDate === undefined) {
    throw new Error(
      'a date range is required: either period (one of ' +
        `${PERIODS.join(', ')}) or both start_date and end_date as YYYY-MM-DD.`
    );
  }

  if (startDate > endDate) {
    throw new Error(
      `start_date (${startDate}) is after end_date (${endDate}) — Search Console ` +
        'returns an empty result for a reversed range rather than an error, so ' +
        'this is refused here.'
    );
  }

  return { startDate, endDate };
}

/**
 * How far behind the present the data is, in days, and why a recent range can
 * look empty.
 *
 * Not a guess dressed as a fact: Google documents the lag as "2 to 3 days" and
 * does not publish a per-property figure, so this says so rather than computing
 * a cutoff and pretending it is exact.
 */
export const FRESHNESS_NOTE =
  'Search Console finalises data 2 to 3 days behind, so the most recent days of ' +
  'a range are usually missing. dataState="ALL" includes the incomplete recent ' +
  'days; the default, "FINAL", does not.';
