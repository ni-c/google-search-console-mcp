import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { orderedResourceKey } from 'mcp-approval';

import { escapeCell } from '../src/analytics.js';
import { addDays, PERIODS, resolvePeriod } from '../src/dates.js';
import { toSiteUrl, toVerificationSite } from '../src/site-identity.js';

/**
 * Properties of the four places a value is transformed rather than passed on.
 *
 * Each carries a failure in its own comments that an example test would only
 * find if somebody had thought of the example: a cell that splits its own table
 * row, a date that lands a day early across a daylight-saving boundary, and a
 * site identifier that "fails by succeeding" — verifying a domain literally
 * called `sc-domain:example.com`, which no property will ever match.
 */

const RUNS = { numRuns: 500 };

describe('a table cell cannot break out of its row', () => {
  /**
   * A dimension value is a query somebody typed into Google, or a page title
   * somebody wrote. Neither is under our control, and both land in a markdown
   * table where a bare `|` ends the cell.
   */
  it('never leaves an unescaped separator or a line break', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (value) => {
        const cell = escapeCell(value);
        expect(cell).not.toMatch(/\r|\n/);
        // Every `|` is preceded by an odd number of backslashes, i.e. escaped.
        for (let i = 0; i < cell.length; i++) {
          if (cell[i] !== '|') continue;
          let slashes = 0;
          for (let j = i - 1; j >= 0 && cell[j] === '\\'; j--) slashes++;
          expect(slashes % 2).toBe(1);
        }
      }),
      RUNS
    );
  });

  /**
   * The subtlety the comment records: cutting escaped text can land between a
   * backslash and the character it escapes, leaving a live `\` at the end of
   * the cell that escapes the separator after it — splitting the row after all,
   * from the truncation rather than from the value.
   */
  it('never ends on a live backslash, however long the value was', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('\\', '|', 'a', 'ü', ' '), { maxLength: 400 }),
        (parts) => {
          const cell = escapeCell(parts.join(''));
          let trailing = 0;
          for (let i = cell.length - 1; i >= 0 && cell[i] === '\\'; i--) {
            trailing++;
          }
          expect(trailing % 2).toBe(0);
        }
      ),
      RUNS
    );
  });

  it('is idempotent on a value that needed no escaping', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9 ]{0,40}$/), (value) => {
        expect(escapeCell(escapeCell(value))).toBe(escapeCell(value));
      }),
      RUNS
    );
  });
});

describe('dates move by whole days, never by a time zone', () => {
  /**
   * The comment on `resolvePeriod` names the failure: subtracting days from a
   * local-midnight `Date` lands on 23:00 the previous day whenever a daylight
   * saving boundary falls in the range, and `toISOString` then reports a date
   * one day early. Generating a whole year of start dates walks over every such
   * boundary rather than hoping one was picked.
   */
  it('adding and subtracting the same number of days returns the date', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-12-31T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: -500, max: 500 }),
        (date, days) => {
          const start = date.toISOString().slice(0, 10);
          expect(addDays(addDays(start, days), -days)).toBe(start);
        }
      ),
      RUNS
    );
  });

  it('one day forward is always the next calendar date', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-12-31T00:00:00Z'),
          noInvalidDate: true,
        }),
        (date) => {
          const start = date.toISOString().slice(0, 10);
          const next = addDays(start, 1);
          expect(
            Date.parse(`${next}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
          ).toBe(86_400_000);
        }
      ),
      RUNS
    );
  });

  /**
   * Every period is inclusive of both ends, which is where the off-by-one
   * lives: `last7days` is seven days, so the start is six back and not seven.
   * One day out here is a whole extra day in every total the tool reports.
   */
  it('a period spans exactly the number of days it names', () => {
    const spans: Record<string, number> = {
      today: 1,
      yesterday: 1,
      last7days: 7,
      last14days: 14,
      last28days: 28,
      last3months: 90,
      last6months: 180,
      last12months: 365,
      last16months: 487,
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...PERIODS),
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-12-31T00:00:00Z'),
          noInvalidDate: true,
        }),
        (period, now) => {
          const { startDate, endDate } = resolvePeriod(period, now);
          const days =
            (Date.parse(`${endDate}T00:00:00Z`) -
              Date.parse(`${startDate}T00:00:00Z`)) /
              86_400_000 +
            1;
          expect(days).toBe(spans[period]);
          expect(startDate <= endDate).toBe(true);
        }
      ),
      RUNS
    );
  });

  it('refuses a string that is not a date rather than inventing one', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (value) => {
        fc.pre(Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
        expect(() => addDays(value, 1)).toThrow('not a date');
      }),
      RUNS
    );
  });
});

describe('a site identifier survives the trip to the verification API', () => {
  /**
   * The failure the comment calls the expensive kind: passing
   * `sc-domain:example.com` through as an identifier is *accepted* by the API
   * and verifies a domain literally called that, which no property will ever
   * match. It fails by succeeding, so a round trip is the only thing that
   * catches it.
   */
  it('round trips a domain property', () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        const site = toVerificationSite(`sc-domain:${domain}`);
        expect(site.type).toBe('INET_DOMAIN');
        expect(site.identifier).toBe(domain);
        expect(toSiteUrl(site)).toBe(`sc-domain:${domain}`);
      }),
      RUNS
    );
  });

  it('round trips a URL-prefix property', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        fc.pre(!url.startsWith('sc-domain:'));
        const site = toVerificationSite(url);
        expect(site.type).toBe('SITE');
        expect(toSiteUrl(site)).toBe(url);
      }),
      RUNS
    );
  });

  /** An Android app has no Search Console property, so it maps to nothing. */
  it('anything that is neither kind maps back to null', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (identifier) => {
        expect(
          toSiteUrl({ type: 'ANDROID_APP', identifier } as never)
        ).toBeNull();
      }),
      RUNS
    );
  });
});

describe('a confirmation key depends on the order of its targets', () => {
  it('swapping two targets changes the key', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9.]{1,12}$/),
        fc.stringMatching(/^[a-z0-9.]{1,12}$/),
        (a, b) => {
          fc.pre(a !== b);
          expect(orderedResourceKey('verify', [a, b])).not.toBe(
            orderedResourceKey('verify', [b, a])
          );
        }
      ),
      RUNS
    );
  });

  it('the same targets under a different operation give a different key', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9.]{1,12}$/), { maxLength: 4 }),
        fc.stringMatching(/^[a-z_]{3,16}$/),
        fc.stringMatching(/^[a-z_]{3,16}$/),
        (targets, first, second) => {
          fc.pre(first !== second);
          expect(orderedResourceKey(first, targets)).not.toBe(
            orderedResourceKey(second, targets)
          );
        }
      ),
      RUNS
    );
  });
});
