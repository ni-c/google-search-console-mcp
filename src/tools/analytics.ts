import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { renderAnalytics, type AnalyticsResponse } from '../analytics.js';
import { READ_ONLY } from './annotations.js';
import { pathSegment } from '../api.js';
import { PERIODS, resolveDateRange } from '../dates.js';
import { objectOf } from '../normalize.js';
import { run, untrustedResult } from '../result.js';
import { isoDate, resolveSite, siteUrlSchema } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * The dimensions Search Console can group by.
 *
 * `hour` is the newest and has a condition attached: it only returns anything
 * together with `data_state: "HOURLY_ALL"`, and only for roughly the last ten
 * days. Combined with the default `FINAL` it produces an empty table and no
 * explanation, which is why the description below says so.
 */
const DIMENSIONS = [
  'date',
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
  'hour',
] as const;

/** The API's ceiling. Not this server's default — see `row_limit` below. */
const MAX_ROW_LIMIT = 25_000;
const DEFAULT_ROW_LIMIT = 100;

export function registerAnalyticsTools(
  server: McpServer,
  { api, config }: ToolContext
): void {
  server.registerTool(
    'query_search_analytics',
    {
      title: 'Query search analytics',
      description:
        'Clicks, impressions, CTR and average position from Google Search, ' +
        'grouped by any combination of dimensions. This is the whole of the ' +
        'Performance report, as an API.\n\n' +
        'Give a date range as either period ("last28days") or start_date and ' +
        'end_date. Data is finalised 2–3 days behind, and only the last 16 ' +
        'months are retained.\n\n' +
        'Two things about the numbers. Rows are capped at row_limit (default ' +
        `${DEFAULT_ROW_LIMIT}, maximum ${MAX_ROW_LIMIT.toLocaleString('en-US')}) and ` +
        'paged with start_row. And with the query dimension, Google withholds ' +
        'rare queries for anonymity, so the rows never sum to the property ' +
        'total — query without it when you need a true total.',
      inputSchema: z.object({
        site_url: siteUrlSchema(config),
        period: z
          .enum(PERIODS)
          .optional()
          .describe(
            'A relative range, resolved against today in Pacific Time — which ' +
              'is the time zone Search Console counts days in. Alternative to ' +
              'start_date/end_date, not combinable with them.'
          ),
        start_date: isoDate
          .optional()
          .describe('First day of the range, inclusive (YYYY-MM-DD)'),
        end_date: isoDate
          .optional()
          .describe('Last day of the range, inclusive (YYYY-MM-DD)'),
        dimensions: z
          .array(z.enum(DIMENSIONS))
          .optional()
          .describe(
            'Group by these, in this order. Omit for a single totals row. ' +
              '"hour" needs data_state="HOURLY_ALL" and only covers about the ' +
              'last ten days.'
          ),
        type: z
          .enum(['WEB', 'IMAGE', 'VIDEO', 'NEWS', 'DISCOVER', 'GOOGLE_NEWS'])
          .optional()
          .describe('Which search surface. Defaults to WEB.'),
        data_state: z
          .enum(['FINAL', 'ALL', 'HOURLY_ALL'])
          .optional()
          .describe(
            'FINAL (default) omits the incomplete recent days; ALL includes ' +
              'them; HOURLY_ALL is required for the "hour" dimension.'
          ),
        aggregation_type: z
          .enum(['AUTO', 'BY_PROPERTY', 'BY_PAGE', 'BY_NEWS_SHOWCASE_PANEL'])
          .optional()
          .describe(
            'How impressions are counted. AUTO (default) is right almost always.'
          ),
        filters: z
          .array(
            z.object({
              dimension: z.enum([
                'QUERY',
                'PAGE',
                'COUNTRY',
                'DEVICE',
                'SEARCH_APPEARANCE',
              ]),
              operator: z
                .enum([
                  'EQUALS',
                  'NOT_EQUALS',
                  'CONTAINS',
                  'NOT_CONTAINS',
                  'INCLUDING_REGEX',
                  'EXCLUDING_REGEX',
                ])
                .optional()
                .describe('Defaults to EQUALS'),
              expression: z
                .string()
                .describe(
                  'The value to match. Comparisons are case-insensitive. ' +
                    'COUNTRY takes a three-letter code such as "deu"; regex ' +
                    'operators take RE2 syntax.'
                ),
            })
          )
          .optional()
          .describe(
            'Restrict the rows. You do not have to group by a dimension to ' +
              'filter on it. Combined with filter_type.'
          ),
        filter_type: z
          .enum(['and', 'or'])
          .optional()
          .describe('How the filters combine. Defaults to "and".'),
        row_limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_LIMIT)
          .optional()
          .describe(
            `Rows to return, ${DEFAULT_ROW_LIMIT} by default. Raising this is ` +
              'the fastest way to fill a context window with near-identical ' +
              'rows; page with start_row instead where you can.'
          ),
        start_row: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Zero-based offset for paging. Defaults to 0.'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const site = resolveSite(config, args.site_url);
        const { startDate, endDate } = resolveDateRange({
          ...(args.period === undefined ? {} : { period: args.period }),
          ...(args.start_date === undefined
            ? {}
            : { startDate: args.start_date }),
          ...(args.end_date === undefined ? {} : { endDate: args.end_date }),
        });

        const dimensions = args.dimensions ?? [];
        const rowLimit = args.row_limit ?? DEFAULT_ROW_LIMIT;
        const startRow = args.start_row ?? 0;

        if (dimensions.includes('hour') && args.data_state !== 'HOURLY_ALL') {
          throw new Error(
            'the "hour" dimension requires data_state="HOURLY_ALL". With any ' +
              'other data state Google returns an empty result and no error, ' +
              'which is indistinguishable from a property with no traffic.'
          );
        }

        const body: Record<string, unknown> = {
          startDate,
          endDate,
          dimensions,
          rowLimit,
          startRow,
        };
        if (args.type !== undefined) body.type = args.type;
        if (args.data_state !== undefined) body.dataState = args.data_state;
        if (args.aggregation_type !== undefined) {
          body.aggregationType = args.aggregation_type;
        }
        if (args.filters !== undefined && args.filters.length > 0) {
          body.dimensionFilterGroups = [
            {
              groupType: args.filter_type ?? 'and',
              filters: args.filters.map((filter) => ({
                dimension: filter.dimension,
                operator: filter.operator ?? 'EQUALS',
                expression: filter.expression,
              })),
            },
          ];
        }

        const response = objectOf(
          await api.post(
            'search-console',
            `/webmasters/v3/sites/${pathSegment(site)}/searchAnalytics/query`,
            body,
            // A query changes nothing, so a retry after a 429 or a 503 is safe —
            // and this is the endpoint most likely to meet one.
            { retryable: true }
          ),
          'search analytics response'
        ) as AnalyticsResponse;

        return untrustedResult(
          renderAnalytics(response, {
            dimensions: [...dimensions],
            startDate,
            endDate,
            site,
            rowLimit,
            startRow,
          })
        );
      })
  );
}
