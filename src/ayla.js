// -----------------------------------------------------------------------------
// The Shark account on Ayla Networks (sharkiq 1.5.1 ayla_api.py, MIT):
//
// - sign-in: the Auth0 id token (src/auth0.js) exchanged at
//   `POST <login>/api/v1/token_sign_in` with the app id and app secret of the
//   region, for an Ayla access token (about 24 h) and a refresh token;
// - renewal: `POST <login>/users/refresh_token.json`, never the password;
// - the calls: `GET <device>/apiv1/devices.json` (the robots),
//   `GET <device>/apiv1/dsns/<dsn>/properties.json` (their properties), and
//   `POST <device>/apiv1/dsns/<dsn>/properties/SET_<name>/datapoints.json`
//   (a command), with `Authorization: auth_token <access token>`.
//
// This client never signs in by itself: src/app.js decides when the password
// may be used (once per saved credentials, then only on a click). A refused
// refresh token drops the tokens and ends as `session_expired`.
// -----------------------------------------------------------------------------

import { auth0SignIn } from './auth0.js';
import { TIMINGS, USER_AGENTS } from './constants.js';
import { SharkError, header, httpRequest, parseJson, parseRetryAfter } from './http.js';

/** A DSN as the integration accepts it (the Ayla device serial number). */
export const DSN = /^[A-Za-z0-9_-]{1,40}$/;
/** An Ayla property name (without the SET_ prefix). */
const NAME = /^[A-Za-z0-9_]{1,64}$/;

/** The error of an Ayla API answer, or undefined when it is a success. */
export function apiError({ status, headers = {} }, now, source = 'api') {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401) {
    return new SharkError('unauthorized', 'token refused', { status });
  }
  if (status === 429) {
    return new SharkError('rate_limited', 'too many requests', {
      status,
      source,
      retryAfter: parseRetryAfter(header(headers, 'retry-after'), now),
    });
  }
  if (status === 403) {
    return new SharkError('forbidden', 'request refused', { status });
  }
  if (status === 404) {
    return new SharkError('not_found', 'not found', { status });
  }
  if (status >= 500) {
    return new SharkError('unavailable', 'Ayla is unavailable', { status });
  }
  return new SharkError('http', 'request failed', { status });
}

/** The tokens of a token_sign_in or refresh answer. */
export function tokensOf(data, now) {
  const access = data?.access_token;
  const refresh = data?.refresh_token;
  const valid = (t) => typeof t === 'string' && t.length >= 8 && t.length <= 8192;
  if (!valid(access) || !valid(refresh)) {
    throw new SharkError('unsupported', 'Ayla sent no tokens');
  }
  const seconds = Number(data.expires_in);
  const lifetime =
    Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds * 1000, TIMINGS.tokenLifetimeMax)
      : TIMINGS.tokenLifetime;
  return { accessToken: access, refreshToken: refresh, expiresAt: now + lifetime, lifetime };
}

export class AylaClient {
  constructor({ transport = httpRequest, now = Date.now, random } = {}) {
    this.transport = transport;
    this.now = now;
    this.random = random;
    this.region = undefined;
    this.email = '';
    this.password = '';
    /** { accessToken, refreshToken, expiresAt } | null */
    this.tokens = null;
    this.renewing = undefined;
    /** When an API 401 last forced a renewal (at most one per unauthorizedRenewGap). */
    this.lastUnauthorizedRenew = -Infinity;
    /** When the last renewal started (two are at least TIMINGS.renewMinGap apart). */
    this.lastRenewAt = -Infinity;
    /** Per-request timeout; undefined = TIMINGS.requestTimeout (shorter for the buttons). */
    this.timeout = undefined;
    /** Called after the tokens changed (persist them). */
    this.onChange = undefined;
  }

  configure({ region, email, password, tokens = null }) {
    this.region = region;
    this.email = email;
    this.password = password;
    this.tokens = tokens?.accessToken && tokens?.refreshToken ? { ...tokens } : null;
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '';
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch {
      // Persisting is best effort: the tokens still work in memory.
    }
  }

  /** The token is valid for `ms` more. */
  tokenValidFor(ms) {
    return Boolean(this.tokens?.accessToken) && this.tokens.expiresAt - ms > this.now();
  }

  /**
   * How long before its expiry the token is renewed: the margin, or half the
   * lifetime of a short token (a 300 s token is renewed after 150 s, never in
   * a loop).
   */
  get margin() {
    const lifetime = this.tokens?.lifetime ?? TIMINGS.tokenLifetime;
    return Math.min(TIMINGS.tokenMargin, lifetime / 2);
  }

  /** When the token should be renewed (its expiry minus the margin), or undefined. */
  get renewAt() {
    return this.tokens ? this.tokens.expiresAt - this.margin : undefined;
  }

  /** JSON POST to the Ayla user service (sign-in, renewal). */
  async userPost(path, payload, timeout) {
    const body = JSON.stringify(payload);
    return this.transport(`${this.region.login}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENTS.browser,
      },
      body,
      timeout: timeout ?? this.timeout ?? TIMINGS.requestTimeout,
    });
  }

  /**
   * The Auth0 step of a sign-in: the password for an id token. Only
   * src/app.js calls it, under its rules (once per click or saved
   * credentials).
   */
  async auth0() {
    if (!this.hasCredentials) {
      throw new SharkError('no_credentials', 'no e-mail or password');
    }
    return auth0SignIn({
      transport: this.transport,
      region: this.region,
      email: this.email,
      password: this.password,
      timeout: this.timeout ?? TIMINGS.requestTimeout,
      now: this.now,
      random: this.random,
    });
  }

  /**
   * The Ayla step: an id token exchanged at token_sign_in (no password), for
   * the Ayla tokens.
   */
  async exchange(idToken) {
    const { email, region } = this;
    const answer = await this.userPost('/api/v1/token_sign_in', {
      app_id: region.appId,
      app_secret: region.appSecret,
      token: idToken,
    });
    if (answer.status === 401 || answer.status === 403) {
      throw new SharkError('refused', 'Ayla refused the SharkNinja sign-in', {
        status: answer.status,
      });
    }
    if (answer.status === 404) {
      // sharkiq: "Confirm app_id and app_secret are correct".
      throw new SharkError('unsupported', 'Ayla does not know the app', { status: 404 });
    }
    const error = apiError(answer, this.now(), 'auth');
    if (error) {
      throw error;
    }
    const tokens = tokensOf(parseJson(answer.body), this.now());
    if (this.email !== email || this.region !== region) {
      throw new SharkError('network', 'the account changed during the sign-in');
    }
    this.tokens = tokens;
    await this.changed();
    return tokens;
  }

  /**
   * A valid token: the current one, else renewed from the refresh token. One
   * renewal at a time. Never the password: no refresh token, or a refused
   * one, is `session_expired`.
   */
  token({ force = false, validity = this.margin, timeout } = {}) {
    if (!force && this.tokenValidFor(validity)) {
      return Promise.resolve(this.tokens.accessToken);
    }
    if (!this.renewing) {
      this.renewing = this.renew({ timeout }).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }
  async renew({ timeout }) {
    const before = this.tokens;
    if (!before?.refreshToken) {
      throw new SharkError('session_expired', 'no session');
    }
    if (this.now() - this.lastRenewAt < TIMINGS.renewMinGap) {
      // Whatever asks (timer, read, 401, command): never two renewals within a minute.
      if (before.accessToken && before.expiresAt > this.now()) {
        return before.accessToken;
      }
      throw new SharkError('unauthorized', 'renewed less than a minute ago');
    }
    this.lastRenewAt = this.now();
    const answer = await this.userPost(
      '/users/refresh_token.json',
      { user: { refresh_token: before.refreshToken } },
      timeout,
    );
    if (answer.status >= 400 && answer.status < 500 && ![408, 429].includes(answer.status)) {
      // Refused: never tried again with this refresh token.
      if (this.tokens === before) {
        this.tokens = null;
        await this.changed();
      }
      throw new SharkError('session_expired', 'the refresh token was refused', {
        status: answer.status,
      });
    }
    const error = apiError(answer, this.now(), 'auth');
    if (error) {
      throw error;
    }
    const tokens = tokensOf(parseJson(answer.body), this.now());
    if (this.tokens !== before) {
      // The account changed (or was emptied) during the renewal.
      throw new SharkError('network', 'the account changed during the renewal');
    }
    this.tokens = tokens;
    await this.changed();
    return tokens.accessToken;
  }

  /** One request to the Ayla device service with a given token. */
  async send(method, path, token, { payload, timeout, startBy } = {}) {
    if (startBy !== undefined && this.now() > startBy) {
      throw new SharkError('late', 'the command deadline passed');
    }
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers = {
      Accept: 'application/json',
      Authorization: `auth_token ${token}`,
      'User-Agent': USER_AGENTS.browser,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const answer = await this.transport(`${this.region.device}${path}`, {
      method,
      headers,
      body,
      timeout:
        (typeof timeout === 'function' ? timeout() : timeout) ??
        this.timeout ??
        TIMINGS.requestTimeout,
    });
    const error = apiError(answer, this.now());
    if (error) {
      throw error;
    }
    return parseJson(answer.body);
  }

  /**
   * An authenticated call. A refused token (401) is renewed once (at most
   * every 10 minutes) and the call tried once more. `retry: false`
   * (commands): never retried, the token is marked for renewal.
   */
  async call(method, path, { retry = true, validity, ...options } = {}) {
    const token = await this.token({ validity });
    try {
      return await this.send(method, path, token, options);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      if (!retry || this.now() - this.lastUnauthorizedRenew < TIMINGS.unauthorizedRenewGap) {
        if (this.tokens?.accessToken === token) {
          // The next call renews it first.
          this.tokens = { ...this.tokens, expiresAt: 0 };
        }
        throw err;
      }
    }
    this.lastUnauthorizedRenew = this.now();
    const renewed = await this.token({ force: true });
    return this.send(method, path, renewed, options);
  }

  /** The devices of the account: the raw `[{ device }]` list. */
  async devices(options = {}) {
    const data = await this.call('GET', '/apiv1/devices.json', options);
    if (!Array.isArray(data)) {
      throw new SharkError('bad_response', 'Ayla sent no device list');
    }
    return data;
  }

  /** The properties of one robot: the raw `[{ property }]` list. */
  async properties(dsn, options = {}) {
    if (!DSN.test(dsn)) {
      throw new SharkError('not_found', 'not a serial number');
    }
    const data = await this.call(
      'GET',
      `/apiv1/dsns/${encodeURIComponent(dsn)}/properties.json`,
      options,
    );
    if (!Array.isArray(data)) {
      throw new SharkError('bad_response', 'Ayla sent no property list');
    }
    return data;
  }

  /** A command: the value of the SET_<name> property of one robot. */
  async setProperty(dsn, name, value, options = {}) {
    if (!DSN.test(dsn) || !NAME.test(name)) {
      throw new SharkError('not_found', 'not a serial number');
    }
    return this.call(
      'POST',
      `/apiv1/dsns/${encodeURIComponent(dsn)}/properties/SET_${name}/datapoints.json`,
      { retry: false, payload: { datapoint: { value } }, ...options },
    );
  }
}
