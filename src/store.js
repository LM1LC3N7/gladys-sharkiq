// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the e-mail nor the password:
//   - the Ayla tokens (access and refresh) with the account they belong to
//     (a hash of the region and the e-mail): a restart does not sign in again;
//   - `signIn`: one sign-in with the password is still allowed for these
//     credentials (they were just saved, or "Sign in" was clicked);
//   - the pauses (429, 5xx) and the stops (refused password, verification,
//     blocked account, expired session), bounded when read back.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/sharkiq-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        // Written and flushed to the disk before the rename: a power cut never
        // leaves an empty or half-written file in place of the tokens.
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const text = (value) =>
  typeof value === 'string' && value.length >= 8 && value.length <= 8192 ? value : undefined;

export const PAUSE_KINDS = ['rate', 'unavailable'];
export const BLOCK_KINDS = ['refused', 'verification', 'locked', 'unsupported', 'session_expired'];

/**
 * The persisted state, repaired; the end of a pause is capped from `now`, so
 * a clock jump or a hand-edited file never pauses for good.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const account = typeof raw?.account === 'string' ? raw.account : '';
  const t = raw?.tokens;
  const tokens =
    account && text(t?.accessToken) && text(t?.refreshToken)
      ? {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAt: time(t.expiresAt) ?? 0,
        }
      : null;
  const p = raw?.pause;
  const pause =
    PAUSE_KINDS.includes(p?.kind) && time(p.until)
      ? {
          kind: p.kind,
          source: p.source === 'auth' ? 'auth' : 'api',
          until: Math.min(
            p.until,
            now + (p.kind === 'rate' ? TIMINGS.rateLimitMax : TIMINGS.unavailableMax),
          ),
        }
      : null;
  const b = raw?.block;
  const block =
    account && BLOCK_KINDS.includes(b?.kind)
      ? {
          kind: b.kind,
          detail:
            typeof b.detail === 'string' && /^[a-z0-9_.-]{1,48}$/i.test(b.detail)
              ? b.detail
              : undefined,
        }
      : null;
  return { account, tokens, pause, block, signIn: account !== '' && raw?.signIn === true };
}
