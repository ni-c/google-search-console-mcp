import { describe, expect, it } from 'vitest';

import {
  addDays,
  resolveDateRange,
  resolvePeriod,
  todayInSearchConsole,
} from '../src/dates.js';

describe('the day Search Console thinks it is', () => {
  it('counts days in Pacific Time, not UTC', () => {
    /*
     * The whole reason this module exists. At 02:00 UTC on the 29th it is still
     * the 28th in Los Angeles, and Search Console buckets impressions by
     * Pacific Time — so a range computed in UTC asks for a day Google has no
     * data for and quietly returns one day fewer than requested.
     */
    expect(todayInSearchConsole(new Date('2026-08-29T02:00:00Z'))).toBe(
      '2026-08-28'
    );
    expect(todayInSearchConsole(new Date('2026-08-29T20:00:00Z'))).toBe(
      '2026-08-29'
    );
  });

  it('follows the daylight saving switch', () => {
    // Pacific is UTC-8 in winter and UTC-7 in summer, so the hour at which the
    // date rolls over moves. A fixed offset would be wrong for half the year.
    expect(todayInSearchConsole(new Date('2026-01-15T07:30:00Z'))).toBe(
      '2026-01-14'
    );
    expect(todayInSearchConsole(new Date('2026-07-15T07:30:00Z'))).toBe(
      '2026-07-15'
    );
  });
});

describe('relative periods', () => {
  const now = new Date('2026-08-28T18:00:00Z');

  it('counts inclusively, so last7days is seven days', () => {
    // Off by one here is a whole extra day in every total, and nothing in the
    // result would show it.
    const range = resolvePeriod('last7days', now);
    expect(range).toEqual({ startDate: '2026-08-22', endDate: '2026-08-28' });
    expect(days(range)).toBe(7);
  });

  it('handles today and yesterday', () => {
    expect(resolvePeriod('today', now)).toEqual({
      startDate: '2026-08-28',
      endDate: '2026-08-28',
    });
    expect(resolvePeriod('yesterday', now)).toEqual({
      startDate: '2026-08-27',
      endDate: '2026-08-27',
    });
  });

  it('gives last28days exactly 28 days', () => {
    expect(days(resolvePeriod('last28days', now))).toBe(28);
  });

  it('crosses a daylight saving boundary without losing a day', () => {
    /*
     * The arithmetic runs on UTC midnights for exactly this case. Subtracting
     * days from a *local* midnight lands on 23:00 the previous day whenever the
     * range spans a switch, and the ISO date then reads one day early.
     */
    const winter = new Date('2026-11-10T20:00:00Z');
    expect(days(resolvePeriod('last28days', winter))).toBe(28);
    expect(resolvePeriod('last28days', winter).endDate).toBe('2026-11-10');
  });
});

describe('resolveDateRange', () => {
  const now = new Date('2026-08-28T18:00:00Z');

  it('takes an explicit range unchanged', () => {
    expect(
      resolveDateRange({ startDate: '2026-01-01', endDate: '2026-01-31' }, now)
    ).toEqual({ startDate: '2026-01-01', endDate: '2026-01-31' });
  });

  it('refuses a period combined with an explicit date', () => {
    // Both spellings are things the caller meant. Picking a winner is how a
    // query ends up covering a range nobody asked for.
    expect(() =>
      resolveDateRange({ period: 'last7days', startDate: '2026-01-01' }, now)
    ).toThrow(/cannot be combined/);
  });

  it('refuses half a range', () => {
    expect(() => resolveDateRange({ startDate: '2026-01-01' }, now)).toThrow(
      /a date range is required/
    );
  });

  it('refuses a reversed range', () => {
    // Google answers a reversed range with an empty result and no error, which
    // is indistinguishable from a property with no traffic.
    expect(() =>
      resolveDateRange({ startDate: '2026-08-28', endDate: '2026-08-01' }, now)
    ).toThrow(/is after end_date/);
  });
});

describe('addDays', () => {
  it('crosses a month and a leap day', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('refuses something that is not a date', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(/not a date/);
  });
});

function days(range: { startDate: string; endDate: string }): number {
  return (
    (Date.parse(`${range.endDate}T00:00:00Z`) -
      Date.parse(`${range.startDate}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}
