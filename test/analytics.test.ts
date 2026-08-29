import { describe, expect, it } from 'vitest';

import { escapeCell, renderAnalytics, summarise } from '../src/analytics.js';

const CONTEXT = {
  dimensions: ['query'],
  startDate: '2026-08-01',
  endDate: '2026-08-28',
  site: 'sc-domain:example.com',
  rowLimit: 100,
  startRow: 0,
};

describe('the totals line', () => {
  it('computes CTR from the totals, not as the mean of the row CTRs', () => {
    /*
     * The difference is not subtle. One obscure query with two impressions and
     * one click has a 50 % CTR; averaging the column gives it the same weight as
     * a query with a million impressions, and the reported figure is then
     * nowhere near the truth.
     */
    const text = summarise([
      { clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
      { clicks: 10, impressions: 1000, ctr: 0.01, position: 20 },
    ]);
    // 11 / 1002 = 1.10 %, not (50 % + 1 %) / 2 = 25.5 %.
    expect(text).toContain('CTR 1.10%');
    expect(text).not.toContain('25.5');
  });

  it('weights average position by impressions', () => {
    /*
     * The larger of the two errors, because position is where the long tail
     * sits. Unweighted, these two average to 41.5; the honest figure is 20.0,
     * because virtually every impression was at position 20.
     */
    const text = summarise([
      { clicks: 0, impressions: 2, ctr: 0, position: 63 },
      { clicks: 10, impressions: 1000, ctr: 0.01, position: 19.9 },
    ]);
    expect(text).toContain('average position 20.0');
  });

  it('says the totals are not the property total', () => {
    // With the query dimension Google withholds rare queries for anonymity,
    // routinely a third or more of all impressions. A total printed without
    // that caveat is a number people will quote.
    expect(summarise([{ clicks: 1, impressions: 1 }])).toMatch(
      /not the property total/
    );
  });

  it('survives rows with missing metrics', () => {
    expect(() => summarise([{}])).not.toThrow();
    expect(summarise([{}])).toContain('0 clicks');
  });
});

describe('rendering the table', () => {
  it('puts the dimension keys in the leading columns', () => {
    const text = renderAnalytics(
      {
        rows: [
          {
            keys: ['blue shoes'],
            clicks: 5,
            impressions: 100,
            ctr: 0.05,
            position: 7.2,
          },
        ],
      },
      CONTEXT
    );
    expect(text).toContain('| query | clicks | impressions | ctr | position |');
    expect(text).toContain('| blue shoes | 5 | 100 | 5.00% | 7.2 |');
  });

  it('escapes a pipe in a search query instead of breaking the row', () => {
    /*
     * Search queries are arbitrary text the public typed. An unescaped pipe
     * splits the row into extra columns and shifts every number after it under
     * the wrong heading — a corrupted table that still looks like a table.
     */
    const text = renderAnalytics(
      {
        rows: [
          {
            keys: ['shoes | nike'],
            clicks: 1,
            impressions: 2,
            ctr: 0.5,
            position: 1,
          },
        ],
      },
      CONTEXT
    );
    expect(text).toContain('shoes \\| nike');

    // The row must still hold five cells — query, clicks, impressions, ctr,
    // position — and not six. Splitting on unescaped pipes only is what an
    // honest Markdown reader does.
    const row = text.split('\n').find((line) => line.includes('shoes'));
    const cells = (row ?? '')
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(cells).toEqual(['shoes \\| nike', '1', '2', '50.00%', '1.0']);
  });

  it('escapes a backslash before the pipe it precedes', () => {
    // A query that already contains `\|` must not come out as `\\|`: the reader
    // would take the `\\` for a literal backslash and the pipe for a column
    // separator, splitting the row after all.
    expect(escapeCell('shoes \\| nike')).toBe('shoes \\\\\\| nike');

    const cells = escapeCell('shoes \\| nike').split(/(?<!\\)\|/);
    expect(cells).toHaveLength(1);
  });

  it('flattens a newline in a query', () => {
    expect(escapeCell('two\nlines')).toBe('two lines');
  });

  it('says so when the result is exactly row_limit long', () => {
    // Almost certainly truncated by the API, and the caller cannot tell from
    // the data itself.
    const rows = Array.from({ length: 3 }, () => ({
      clicks: 1,
      impressions: 1,
    }));
    const text = renderAnalytics({ rows }, { ...CONTEXT, rowLimit: 3 });
    expect(text).toContain('start_row=3');
  });

  it('reports an empty result as empty, with the freshness caveat', () => {
    // The most common cause of "no data" is asking for the last two days, which
    // are not final yet.
    const text = renderAnalytics({}, CONTEXT);
    expect(text).toContain('No data for this range');
    expect(text).toContain('2 to 3 days');
  });

  it('handles a query with no dimensions', () => {
    const text = renderAnalytics(
      { rows: [{ clicks: 9, impressions: 10, ctr: 0.9, position: 1.5 }] },
      { ...CONTEXT, dimensions: [] }
    );
    expect(text).toContain('(none — one totals row)');
    expect(text).toContain('| clicks | impressions | ctr | position |');
  });
});
