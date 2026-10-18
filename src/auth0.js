// -----------------------------------------------------------------------------
// The SharkNinja Auth0 sign-in, which gives the id token Ayla then exchanges
// for its own tokens (src/ayla.js). Ported from sharkiq 1.5.1 (MIT):
//
// - EU (`flow: 'password'`): the Auth0 password grant, `POST /oauth/token`
//   (sharkiq `_legacy_cookie_sign_in` with `europe=True`, auth0-python
//   `GetToken.login`);
// - US (`flow: 'cross_origin'`): `POST /co/authenticate` (a login ticket),
//   `GET /authorize` with the ticket and PKCE, the consent page when Auth0
//   shows one, `/authorize/resume`, then the code of the app's deep link
//   exchanged at `POST /oauth/token` (sharkiq auth0.py `do_auth0_login`).
//
// Unlike sharkiq, a failed flow is never tried again with the other one in
// the same sign-in: each password attempt counts against the Auth0 brute
// force protection, and "requires_verification" means a CAPTCHA or a code.
// Every refusal is final until the user acts (src/app.js).
//
// The redirects are read by hand, only on the Auth0 origin of the region: a
// Location to another host ends the sign-in. Cookies are kept for the
// sign-in only (the flow needs the Auth0 session cookies between steps).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { AUTH0_REDIRECT_URI, AUTH0_SCOPES, LIMITS, TIMINGS, USER_AGENTS } from './constants.js';
import { BEFORE_SEND, SharkError, header, networkError, parseRetryAfter, tryJson } from './http.js';

/** Auth0 `error` codes that mean "a person must act" (a CAPTCHA, a code, MFA). */
const VERIFICATION = new Set([
  'requires_verification',
  'mfa_required',
  'mfa_registration_required',
]);
/** Auth0 `error` codes of a blocked account. */
const LOCKED = new Set(['too_many_attempts', 'blocked_user', 'user_blocked']);

/** An Auth0 `error` code, only when it looks like one (never free text). */
const codeOf = (data) =>
  typeof data?.error === 'string' && /^[a-z0-9_.-]{1,48}$/i.test(data.error)
    ? data.error
    : undefined;

/** The error of an Auth0 answer, or undefined when it is a success. */
export function auth0Error({ status, headers = {}, body }, now = Date.now()) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  const code = codeOf(tryJson(body));
  if (status === 429) {
    if (LOCKED.has(code)) {
      return new SharkError('locked', 'Auth0 blocked the account', { status, code });
    }
    return new SharkError('rate_limited', 'too many sign-in requests', {
      status,
      code,
      source: 'auth',
      retryAfter: parseRetryAfter(header(headers, 'retry-after'), now),
    });
  }
  if (status >= 500) {
    return new SharkError('unavailable', 'the SharkNinja sign-in is unavailable', { status, code });
  }
  if (VERIFICATION.has(code)) {
    return new SharkError('verification', 'Auth0 asks for a verification', { status, code });
  }
  if (LOCKED.has(code)) {
    return new SharkError('locked', 'Auth0 blocked the account', { status, code });
  }
  if (status === 401 || status === 403) {
    return new SharkError('refused', 'the e-mail or the password was refused', { status, code });
  }
  return new SharkError('unsupported', 'unexpected sign-in answer', { status, code });
}

/** A PKCE pair (S256), as auth0.py `_generate_pkce_pair`. */
export function pkcePair(random = randomBytes) {
  const verifier = Buffer.from(random(32)).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

/**
 * The cookies of one sign-in: `name=value` of every Set-Cookie (the
 * attributes ignored; one host only, so no domain or path matching).
 */
export function cookieJar() {
  const cookies = new Map();
  return {
    take(headers) {
      const raw = headers?.['set-cookie'];
      for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        const pair = String(line).split(';', 1)[0];
        const at = pair.indexOf('=');
        if (at <= 0) {
          continue;
        }
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (/^[\w.-]{1,64}$/.test(name) && value.length <= 4096 && !/[;\r\n]/.test(value)) {
          if (cookies.has(name) || cookies.size < LIMITS.cookies) {
            cookies.set(name, value);
          }
        }
      }
    },
    get header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    get size() {
      return cookies.size;
    },
  };
}

const idTokenOf = (data) => {
  const token = data?.id_token;
  if (typeof token !== 'string' || token.length < 10 || token.length > 16_384) {
    throw new SharkError('unsupported', 'Auth0 sent no id token');
  }
  return token;
};

/** The JSON body of a successful Auth0 answer. */
function successJson(answer, now) {
  const error = auth0Error(answer, now);
  if (error) {
    throw error;
  }
  const data = tryJson(answer.body);
  if (!data || typeof data !== 'object') {
    throw new SharkError('unsupported', 'unexpected sign-in answer', { status: answer.status });
  }
  return data;
}

/**
 * The id token of the e-mail and the password. `region`: an entry of
 * REGIONS. Throws a SharkError (see auth0Error).
 */
export async function auth0SignIn({
  transport,
  region,
  email,
  password,
  timeout = TIMINGS.requestTimeout,
  now = Date.now,
  random,
}) {
  // The first request carries the password: a failure proved to come before
  // any byte left (BEFORE_SEND) is marked, so the caller may try once more.
  let calls = 0;
  const counted = async (url, options) => {
    calls += 1;
    const first = calls === 1;
    try {
      return await transport(url, options);
    } catch (err) {
      const error = err instanceof SharkError ? err : networkError(err);
      if (first && error.kind === 'network' && BEFORE_SEND.has(error.socket)) {
        error.beforeSend = true;
      }
      throw error;
    }
  };
  if (region.flow === 'password') {
    return passwordGrant({ transport: counted, region, email, password, timeout, now });
  }
  return crossOrigin({ transport: counted, region, email, password, timeout, now, random });
}

/** Marks an error raised after Auth0 accepted the password ("sign-in not finished"). */
const afterPassword = (err) => {
  const error = err instanceof SharkError ? err : networkError(err);
  error.afterPassword = true;
  return error;
};

async function passwordGrant({ transport, region, email, password, timeout, now }) {
  const body = JSON.stringify({
    grant_type: 'password',
    client_id: region.clientId,
    username: email,
    password,
    scope: AUTH0_SCOPES,
  });
  const answer = await transport(`${region.auth0}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': USER_AGENTS.browser,
    },
    body,
    timeout,
  });
  const data = successJson(answer, now());
  try {
    return idTokenOf(data);
  } catch (err) {
    // A 200 without an id token: the password was accepted.
    throw afterPassword(err);
  }
}

/**
 * The query of the app's deep link, or undefined when `location` is not
 * exactly that link (same scheme, host and path, then `?` or nothing): a
 * look-alike ("…/callback.evil?code=", "…/callback/../x?code=") is refused.
 */
export function deepLinkParams(location) {
  if (typeof location !== 'string' || !location.startsWith(AUTH0_REDIRECT_URI)) {
    return undefined;
  }
  const rest = location.slice(AUTH0_REDIRECT_URI.length);
  if (rest !== '' && !rest.startsWith('?')) {
    return undefined;
  }
  return new URLSearchParams(rest.slice(1).split('#', 1)[0]);
}

/** A Location of the region's Auth0 origin as an absolute URL, or the exact deep link. */
function locationOf(answer, origin) {
  const location = header(answer.headers, 'location') ?? '';
  if (deepLinkParams(location)) {
    return location;
  }
  if (location === '') {
    return '';
  }
  let url;
  try {
    url = new URL(location, origin);
  } catch {
    throw new SharkError('unsupported', 'unexpected sign-in redirect');
  }
  if (url.origin !== origin) {
    // Never followed outside the Auth0 tenant of the region.
    throw new SharkError('unsupported', 'sign-in redirect to another host');
  }
  return url.href;
}

async function crossOrigin({ transport, region, email, password, timeout, now, random }) {
  const origin = new URL(region.auth0).origin;
  const jar = cookieJar();
  const base = {
    'User-Agent': USER_AGENTS.mobile,
    Origin: origin,
    Referer: `${origin}/`,
  };
  const call = async (
    url,
    { method = 'GET', form, json, accept = 'application/json', bare = false } = {},
  ) => {
    // `bare`: the code exchange sends only its Content-Type, as auth0.py does.
    const headers = bare ? {} : { ...base, Accept: accept };
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
    }
    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (!bare && jar.size > 0) {
      headers.Cookie = jar.header;
    }
    const answer = await transport(url, {
      method,
      headers,
      body,
      timeout,
      maxBytes: LIMITS.pageBytes,
    });
    jar.take(answer.headers);
    return answer;
  };

  // 1. The password, for a login ticket.
  const ticketAnswer = await call(`${origin}/co/authenticate`, {
    method: 'POST',
    form: {
      client_id: region.clientId,
      credential_type: 'http://auth0.com/oauth/grant-type/password-realm',
      username: email,
      password,
      realm: 'Username-Password-Authentication',
    },
  });
  const ticket = successJson(ticketAnswer, now()).login_ticket;
  if (typeof ticket !== 'string' || ticket === '' || ticket.length > 4096) {
    throw afterPassword(new SharkError('unsupported', 'Auth0 sent no login ticket'));
  }
  // The password was accepted: whatever fails from here is "not finished".
  try {
    return await finishCrossOrigin({ call, origin, region, ticket, now, random });
  } catch (err) {
    throw afterPassword(err);
  }
}

async function finishCrossOrigin({ call, origin, region, ticket, now, random }) {
  // 2. The authorization with the ticket and PKCE: a redirect, read by hand.
  const pkce = pkcePair(random);
  const query = new URLSearchParams({
    os: 'android',
    response_type: 'code',
    client_id: region.clientId,
    redirect_uri: AUTH0_REDIRECT_URI,
    scope: AUTH0_SCOPES,
    login_ticket: ticket,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    screen_hint: 'signin',
    ui_locales: 'en',
    mobile_shark_app_version: 'rn1.01',
  });
  const redirected = (answer) => {
    if (answer.status >= 300 && answer.status < 400) {
      return locationOf(answer, origin);
    }
    const error = auth0Error(answer, now());
    throw error ?? new SharkError('unsupported', 'no sign-in redirect', { status: answer.status });
  };
  let location = redirected(await call(`${origin}/authorize?${query}`, { accept: 'text/html' }));

  // 3. The consent page, when Auth0 shows one: its state, accepted.
  if (location.startsWith(`${origin}/u/consent`)) {
    const page = await call(location, { accept: 'text/html' });
    const pageError = auth0Error(page, now());
    if (pageError) {
      throw pageError;
    }
    const state = /name="state"\s+value="([^"]{1,2048})"/.exec(page.body ?? '')?.[1];
    if (!state) {
      throw new SharkError('unsupported', 'no state on the consent page');
    }
    location = redirected(
      await call(location, {
        method: 'POST',
        form: { state, action: 'accept' },
        accept: 'text/html',
      }),
    );
  }

  // 4. The resume, which redirects to the app's deep link with the code.
  if (location.startsWith(`${origin}/authorize/resume`)) {
    location = redirected(await call(location, { accept: 'text/html' }));
  }
  // The code is read only from the exact deep link of the app.
  const params = deepLinkParams(location);
  if (!params) {
    throw new SharkError('unsupported', 'no authorization code');
  }
  const refused = codeOf({ error: params.get('error') ?? undefined });
  if (refused) {
    throw auth0Error({ status: 403, body: JSON.stringify({ error: refused }) }, now());
  }
  const code = params.get('code');
  if (!code || code.length > 4096) {
    throw new SharkError('unsupported', 'no authorization code');
  }

  // 5. The code and the PKCE verifier, for the tokens.
  const tokens = await call(`${origin}/oauth/token`, {
    method: 'POST',
    bare: true,
    json: {
      grant_type: 'authorization_code',
      client_id: region.clientId,
      code,
      redirect_uri: AUTH0_REDIRECT_URI,
      code_verifier: pkce.verifier,
    },
  });
  return idTokenOf(successJson(tokens, now()));
}
