import { createHash } from 'node:crypto';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { errorResult } from './result.js';

/**
 * A key binding the token to an ordered tuple of targets.
 *
 * Deliberately **not** `setResourceKey` from mcp-approval, which sorts: the
 * targets here are a tuple, not a set. `delete_sitemap` binds a property and a
 * feedpath in that order, and `update_site_owners` puts the property first and
 * sorts only the owner list after it. Sorting the whole array would fold the
 * property into that run and make two different calls share a key.
 */
export function tupleResourceKey(operation: string, targets: string[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(targets))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * Wraps an operation that must not happen on the first call.
 *
 * Three tools need this exact dance, and writing it out three times is how one
 * of them ends up subtly different — a resource key without the target in it,
 * say, which would let a confirmation for one property delete another.
 *
 * `targets` is what the token is bound to. It must contain everything that
 * decides *what* gets touched, not just the property: `delete_sitemap` takes a
 * property and a feedpath, and a token issued for one sitemap must not
 * authorise removing a different one from the same property. The order is
 * preserved, so a caller with a genuine *set* — `update_site_owners` — sorts
 * that part itself rather than having every tuple flattened for it.
 *
 * Nothing coming from the API may be passed into `what` or `consequence`. Those
 * two sentences are the instruction a model acts on, and this server's upstream
 * content includes text written by the public and by whoever runs the crawled
 * site. `target` exists for the cases where the operation is meaningless without
 * naming the thing — a sitemap URL, a list of addresses — and it is rendered
 * outside the instruction, on its own line, flattened to a single line and
 * capped. A confirmation that will not say what it is about is not much of a
 * confirmation; a confirmation whose subject can rewrite the sentence is worse.
 */
export async function guarded(
  server: McpServer,
  ctx: ServerContext,
  approval: Approver,
  confirmations: ConfirmationStore,
  options: {
    tool: string;
    targets: string[];
    what: string;
    consequence: string;
    /** Shown as quoted data, never as part of the instruction. */
    target?: string;
    confirmToken: string | undefined;
  },
  perform: () => Promise<CallToolResult>
): Promise<CallToolResult | InputRequiredResult> {
  const outcome = await approval.requestApproval(server, ctx, confirmations, {
    what: options.what,
    consequence: options.consequence,
    resourceKey: tupleResourceKey(options.tool, options.targets),
    token: options.confirmToken,
    toolName: options.tool,
    title: `${options.what[0]?.toUpperCase()}${options.what.slice(1)}?`,
    hint: 'Tick to go ahead, leave it to cancel.',
    ...(options.target === undefined
      ? {}
      : { details: [{ label: 'Target', value: options.target }] }),
  });

  if (outcome.decision === 'approved') return perform();
  if (outcome.decision === 'declined') {
    return errorResult(`The user declined. ${options.tool} did nothing.`);
  }
  // A token that was sent and did not match is refused with the reason rather
  // than answered with a fresh prompt: it means the call carried a
  // confirmation issued for different arguments, which is exactly what the
  // resource key is there to catch. The sentence comes from the library so
  // every server in the fleet refuses in the same words.
  if (outcome.decision === 'rejected') return errorResult(outcome.reason);
  return outcome.result;
}
