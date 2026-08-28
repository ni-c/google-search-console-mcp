import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Issues short-lived confirmation tokens for operations that need a second look.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in upstream content,
 * and this server hands the model plenty of that: page titles, query strings
 * that real people typed into Google, and the crawl diagnostics of pages
 * written by whoever runs the site. A random token that only ever appears in a
 * *previous* tool result cannot be guessed.
 *
 * The token is bound to a resource key, so a confirmation for one target cannot
 * be replayed for another — which matters more here than usual, because the
 * three guarded operations are all irreversible in the way that counts. A
 * deleted property takes its entire search history with it; Search Console
 * keeps roughly sixteen months of data and re-adding the property does not
 * bring any of it back.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /**
   * Returns true and consumes the token when it matches the pending one for
   * `resource` and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    if (Date.now() >= entry.expiresAt) {
      this.pending.delete(resource);
      return false;
    }
    if (!constantTimeEquals(token, entry.token)) return false;
    this.pending.delete(resource);
    return true;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

/** Compares two tokens without leaking their common prefix through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would leak the length —
  // hash first so the comparison is always over the same number of bytes.
  const digest = (value: Buffer): Buffer =>
    createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Resource key for an operation on a *set* of targets. Without the fingerprint a
 * confirmation for ["a"] would also execute ["a", "b"] — the model chooses the
 * second list, and only the operation name would have been checked.
 */
export function setResourceKey(operation: string, targets: string[]): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...targets].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * Builds the text returned by the first call of a guarded tool.
 *
 * Note what is NOT in here: no name, description or tag coming from the API.
 * Those are attacker-controllable and this string is read by a model.
 */
export function confirmationPrompt(
  what: string,
  consequence: string,
  toolName: string,
  token: string,
  ttlMinutes: number
): string {
  return (
    `This will ${what}. ${consequence}\n\n` +
    `To proceed, call ${toolName} again with the same arguments plus ` +
    `confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}
