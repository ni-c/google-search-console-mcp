/**
 * The annotation block every reading tool of this server carries, and the rule
 * the writing ones follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * Here the thing that is lost is not content but *history*. Search Console
 * keeps roughly sixteen months of performance data per property, and removing
 * a property discards all of it — re-adding starts an empty history. That is
 * what makes `delete_site` destructive, not the row in a list.
 *
 * `openWorldHint: false`: the Google API endpoints are fixed and not
 * configurable, so this is as closed as a world gets. What Google's crawler
 * then does with a submitted sitemap is Google's business, not a property of
 * the tool call.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
