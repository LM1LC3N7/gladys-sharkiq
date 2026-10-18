// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to the SharkNinja Auth0 tenant and
// to Ayla Networks, and the errors they end with. Redirects are never
// followed (the sign-in reads them itself). The body read is bounded; the
// messages never hold a secret (no password, token, e-mail, serial number).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed call. `kind`:
 * - `no_credentials`: no e-mail or password (never sent);
 * - `refused`: the e-mail or the password was refused (Auth0), or the Auth0
 *   token by Ayla;
 * - `verification`: Auth0 asks for a verification (bot detection, a code,
 *   MFA): never handled, never retried by itself;
 * - `locked`: Auth0 blocked the account after too many attempts;
 * - `unsupported`: a sign-in answer or step this integration does not know;
 * - `session_expired`: the refresh token was refused, or there is none:
 *   only a click on "Sign in" signs in again with the password;
 * - `unauthorized`: the API refused the token (401);
 * - `forbidden`: 403; `not_found`: 404;
 * - `rate_limited`: 429, `retryAfter` in ms when given, `source` 'auth' | 'api';
 * - `unavailable`: 5xx;
 * - `network`, `timeout`: no answer; `late`: not sent, the command deadline passed;
 * - `bad_response`, `size`: not the expected answer;
 * - `http`: any other status.
 */
export class SharkError extends Error {
  constructor(kind, message, { status, retryAfter, code, source } = {}) {
    super(message);
    this.name = 'SharkError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    /** A short machine code of the cloud (an Auth0 `error`), checked: never free text. */
    this.code = code;
    this.source = source;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> SharkError (never the request: a sign-in carries the password). */
export function networkError(err) {
  if (err instanceof SharkError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  return new SharkError('network', NETWORK_REASONS[code] ?? (code || 'network error'));
}

/** A short, secret-free reason for a log. */
export function errorReason(err) {
  if (err instanceof SharkError) {
    const details = [err.code, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status. The
 * promise settles once; the body read is bounded.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new SharkError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    timer = setTimeout(() => {
      settle(reject, new SharkError('timeout', `no answer within ${Math.round(timeout / 1000)} s`));
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body; `undefined` for an empty body. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SharkError('bad_response', 'the answer is not JSON');
  }
}

/** The JSON of a body, or undefined when it is not JSON (an error page). */
export function tryJson(body) {
  try {
    return parseJson(body);
  } catch {
    return undefined;
  }
}

/** A header of a Node answer (lower-case names), as one string. */
export function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : undefined;
}
