import { FRESHNESS_NOTE } from './dates.js';

/** One row of a Search Analytics response. */
export interface AnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface AnalyticsResponse {
  rows?: AnalyticsRow[];
  responseAggregationType?: string;
}

/** How many rows the table may carry before it is cut. */
const MAX_TABLE_ROWS = 1000;

/**
 * Renders a Search Analytics response as a compact table.
 *
 * A table rather than the API's JSON because the JSON repeats five key names on
 * every single row — `{"keys":["…"],"clicks":3,"impressions":57,"ctr":0.052,
 * "position":18.3}` — and a thousand rows of that is mostly punctuation. The
 * same data as a table is roughly a third of the tokens, and a model reads it
 * without parsing anything.
 */
export function renderAnalytics(
  response: AnalyticsResponse,
  context: {
    dimensions: string[];
    startDate: string;
    endDate: string;
    site: string;
    rowLimit: number;
    startRow: number;
  }
): string {
  const rows = response.rows ?? [];
  const header = [
    `Property: ${context.site}`,
    `Range: ${context.startDate} to ${context.endDate}`,
    `Dimensions: ${context.dimensions.length > 0 ? context.dimensions.join(', ') : '(none — one totals row)'}`,
    `Rows: ${rows.length}`,
  ].join('\n');

  if (rows.length === 0) {
    return `${header}\n\nNo data for this range.\n\n${FRESHNESS_NOTE}`;
  }

  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const columns = [
    ...context.dimensions,
    'clicks',
    'impressions',
    'ctr',
    'position',
  ];

  const lines = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...shown.map((row) => {
      const cells = [
        ...(row.keys ?? []).map(escapeCell),
        formatInteger(row.clicks),
        formatInteger(row.impressions),
        formatPercent(row.ctr),
        formatPosition(row.position),
      ];
      return `| ${cells.join(' | ')} |`;
    }),
  ];

  const parts = [header, '', lines.join('\n'), '', summarise(rows)];

  if (shown.length < rows.length) {
    parts.push(
      `Only the first ${shown.length} of ${rows.length} rows are shown. The ` +
        'totals above cover all of them. Narrow the query with a dimension ' +
        'filter, or page with start_row.'
    );
  }
  if (rows.length === context.rowLimit) {
    parts.push(
      `The result is exactly row_limit (${context.rowLimit}) rows long, so there ` +
        `are almost certainly more. Continue with start_row=${
          context.startRow + context.rowLimit
        }.`
    );
  }
  parts.push(FRESHNESS_NOTE);

  return parts.join('\n');
}

/**
 * The totals line.
 *
 * Two things here are easy to get wrong and both produce numbers that look
 * right:
 *
 * - **CTR is not the mean of the row CTRs.** It is total clicks over total
 *   impressions. Averaging the column gives every row equal weight, so one
 *   obscure query with two impressions and one click contributes a 50 % CTR
 *   alongside a query with a million impressions.
 * - **Average position must be weighted by impressions**, for the same reason
 *   and with a larger effect, because position is where the long tail sits: a
 *   thousand rare queries ranking 80th would drag an unweighted average into
 *   the nineties while the property's real average is 12.
 *
 * And the caveat that is not arithmetic at all: **these are the sums of the rows
 * Google returned, which is not the property total.** When the query dimension
 * is used, Google omits queries too rare to be anonymous, and the omitted rows
 * still happened. The difference is routinely 30–50 % of impressions. Saying so
 * is the only honest way to print a total next to a query breakdown.
 */
export function summarise(rows: AnalyticsRow[]): string {
  const clicks = sum(rows, (row) => row.clicks);
  const impressions = sum(rows, (row) => row.impressions);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const weightedPosition =
    impressions > 0
      ? sum(rows, (row) => (row.position ?? 0) * (row.impressions ?? 0)) /
        impressions
      : 0;

  return (
    `Totals over ${rows.length} row${rows.length === 1 ? '' : 's'}: ` +
    `${formatInteger(clicks)} clicks, ${formatInteger(impressions)} impressions, ` +
    `CTR ${formatPercent(ctr)}, average position ${formatPosition(weightedPosition)} ` +
    '(weighted by impressions).\n' +
    'These are sums of the returned rows, not the property total: with the query ' +
    'dimension Google withholds rare queries for anonymity, which commonly ' +
    'accounts for a third or more of all impressions. Query without the query ' +
    'dimension for a true total.'
  );
}

function sum(
  rows: AnalyticsRow[],
  pick: (row: AnalyticsRow) => number | undefined
): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

/**
 * Escapes a dimension value for a Markdown table cell.
 *
 * Search queries are arbitrary text that the public typed, and a pipe in one —
 * `shoes | nike`, or any query someone pasted a table row into — silently splits
 * the row into extra columns and shifts every number after it into the wrong
 * heading. Newlines do the same to the whole table.
 *
 * Backslashes go first: escaping only the pipe turns `shoes \| nike` into
 * `shoes \\| nike`, which a Markdown reader parses as an escaped backslash
 * followed by a live column separator — the very split the escaping is for.
 */
export function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function formatInteger(value: number | undefined): string {
  return Math.round(value ?? 0).toLocaleString('en-US');
}

/** CTR arrives as a fraction; two decimals is the resolution Search Console shows. */
function formatPercent(value: number | undefined): string {
  return `${((value ?? 0) * 100).toFixed(2)}%`;
}

/** Position is 1-based and fractional; one decimal is what the interface shows. */
function formatPosition(value: number | undefined): string {
  return (value ?? 0).toFixed(1);
}
