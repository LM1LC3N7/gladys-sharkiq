// -----------------------------------------------------------------------------
// A fake SharkNinja Auth0 tenant (EU password grant; US cross-origin flow with
// cookies, consent page and PKCE checked for real) and a fake Ayla cloud
// (token_sign_in, refresh, devices, properties, datapoints) behind the
// transport the integration is given (no network). Robots change on a
// datapoint. Records every request.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { AUTH0_REDIRECT_URI } from '../../src/constants.js';
import { SharkError } from '../../src/http.js';
import { EMAIL, HOUR, PASSWORD, TEST_REGIONS, propertyList, robots } from '../fixtures/shark.js';

const json = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

const HOSTS = {};
for (const [key, region] of Object.entries(TEST_REGIONS)) {
  HOSTS[new URL(region.auth0).host] = { role: 'auth0', key, region };
  HOSTS[new URL(region.login).host] = { role: 'login', key, region };
  HOSTS[new URL(region.device).host] = { role: 'device', key, region };
}

export function fakeShark({ lifetime = 24 * HOUR, consent = true } = {}) {
  const server = {
    email: EMAIL,
    password: PASSWORD,
    lifetime,
    /** The US flow shows the consent page. */
    consent,
    /** An Auth0 `error` answered to every sign-in (e.g. 'requires_verification'). */
    auth0Error: undefined,
    robots: robots(),
    requests: [],
    /** Live Ayla access tokens -> expiry; refresh tokens; Auth0 id tokens. */
    access: new Map(),
    refresh: new Set(),
    ids: new Set(),
    /** US flow state. */
    tickets: new Map(),
    codes: new Map(),
    sessions: new Set(),
    beeps: 0,
    /** Every token ever made, to check none reaches the logs. */
    secrets: [],
    down: false,
    /** One-shot answers: { match(request), status, body, headers, before(), throws } */
    queue: [],
    of(role) {
      return this.requests.filter((r) => r.role === role);
    },
    signIns() {
      return this.requests.filter(
        (r) =>
          (r.path === '/oauth/token' && r.body?.grant_type === 'password') ||
          r.path === '/co/authenticate',
      );
    },
    passwordsSent() {
      return this.requests.filter((r) => JSON.stringify(r.body ?? '').includes(PASSWORD)).length;
    },
    refreshes() {
      return this.requests.filter((r) => r.path === '/users/refresh_token.json');
    },
    commands() {
      return this.requests
        .filter((r) => r.method === 'POST' && r.role === 'device')
        .map((r) => [/SET_(\w+)\/datapoints/.exec(r.path)[1], r.body?.datapoint?.value]);
    },
    reads(dsn) {
      return this.requests.filter((r) => r.path === `/apiv1/dsns/${dsn}/properties.json`);
    },
    token(prefix) {
      const value = `${prefix}-${randomBytes(12).toString('hex')}`;
      this.secrets.push(value);
      return value;
    },
    issue() {
      const access = this.token('access');
      const refresh = this.token('refresh');
      this.access.set(access, Date.now() + this.lifetime);
      this.refresh.add(refresh);
      return {
        access_token: access,
        refresh_token: refresh,
        expires_in: Math.round(this.lifetime / 1000),
        role: 'EndUser',
      };
    },
    /** Refuse every Ayla token issued so far (revoked on the server side). */
    revoke() {
      this.access.clear();
      this.refresh.clear();
    },
  };

  const idToken = () => {
    const id = server.token('eyJpZC10b2tlbi');
    server.ids.add(id);
    return id;
  };
  const credentialsOk = (username, password) =>
    String(username).toLowerCase() === server.email.toLowerCase() && password === server.password;

  function auth0(request, region) {
    const { path, method, body = {} } = request;
    if (server.auth0Error) {
      return json(server.auth0Error === 'too_many_attempts' ? 429 : 401, {
        error: server.auth0Error,
        error_description: 'Please verify you are a human.',
      });
    }
    if (method === 'POST' && path === '/oauth/token' && body.grant_type === 'password') {
      if (region.flow !== 'password' || body.client_id !== region.clientId) {
        return json(403, { error: 'unauthorized_client' });
      }
      if (!credentialsOk(body.username, body.password)) {
        return json(403, { error: 'invalid_grant', error_description: 'Wrong email or password.' });
      }
      return json(200, {
        id_token: idToken(),
        access_token: server.token('a0'),
        expires_in: 86400,
      });
    }
    if (method === 'POST' && path === '/co/authenticate') {
      if (body.client_id !== region.clientId || !credentialsOk(body.username, body.password)) {
        return json(401, { error: 'access_denied', error_description: 'Wrong email or password.' });
      }
      const ticket = server.token('ticket');
      const session = server.token('sess');
      server.sessions.add(session);
      server.tickets.set(ticket, session);
      return json(
        200,
        { login_ticket: ticket, co_verifier: 'x', co_id: 'y' },
        { 'set-cookie': [`auth0=${session}; Path=/; HttpOnly; Secure`, 'did=abc123; Path=/'] },
      );
    }
    const cookie = String(request.headers.Cookie ?? '');
    const session = /auth0=([^;]+)/.exec(cookie)?.[1];
    if (method === 'GET' && path === '/authorize') {
      const ticket = request.query.get('login_ticket');
      if (server.tickets.get(ticket) !== session || !server.sessions.has(session)) {
        return json(302, '', { location: '/u/login?state=nope' });
      }
      const code = server.token('code');
      server.codes.set(code, request.query.get('code_challenge'));
      server.pendingCode = code;
      return server.consent
        ? json(302, '', { location: '/u/consent?state=consent-state-1' })
        : json(302, '', { location: `${AUTH0_REDIRECT_URI}?code=${code}&state=s` });
    }
    if (path === '/u/consent' && method === 'GET') {
      return json(
        200,
        '<form method="post"><input type="hidden" name="state" value="consent-state-1"><button name="action" value="accept">Accept</button></form>',
      );
    }
    if (path === '/u/consent' && method === 'POST') {
      if (body.state !== 'consent-state-1' || body.action !== 'accept') {
        return json(400, { error: 'invalid_request' });
      }
      return json(302, '', { location: '/authorize/resume?state=consent-state-1' });
    }
    if (path === '/authorize/resume') {
      return json(302, '', {
        location: `${AUTH0_REDIRECT_URI}?code=${server.pendingCode}&state=s`,
      });
    }
    if (method === 'POST' && path === '/oauth/token' && body.grant_type === 'authorization_code') {
      const challenge = server.codes.get(body.code);
      server.codes.delete(body.code);
      const computed = createHash('sha256')
        .update(String(body.code_verifier), 'ascii')
        .digest('base64url');
      if (!challenge || challenge !== computed || body.redirect_uri !== AUTH0_REDIRECT_URI) {
        return json(403, { error: 'invalid_grant' });
      }
      return json(200, { id_token: idToken(), access_token: server.token('a0') });
    }
    return json(404, { error: 'not_found' });
  }

  function login(request, region) {
    const { path, body = {} } = request;
    if (path === '/api/v1/token_sign_in') {
      if (body.app_id !== region.appId || body.app_secret !== region.appSecret) {
        return json(404, { errors: 'Could not find application' });
      }
      if (!server.ids.has(body.token)) {
        return json(401, { errors: 'Invalid token' });
      }
      server.ids.delete(body.token);
      return json(200, server.issue());
    }
    if (path === '/users/refresh_token.json') {
      const token = body.user?.refresh_token;
      if (!server.refresh.has(token)) {
        return json(401, { error: 'Your refresh token is invalid' });
      }
      server.refresh.delete(token);
      return json(200, server.issue());
    }
    return json(404, {});
  }

  function device(request) {
    const token = String(request.headers.Authorization ?? '').replace(/^auth_token /, '');
    const exp = server.access.get(token);
    if (exp === undefined || Date.now() >= exp) {
      return json(401, { error: 'Your access token is invalid or expired.' });
    }
    const { path, method } = request;
    if (method === 'GET' && path === '/apiv1/devices.json') {
      return json(
        200,
        Object.entries(server.robots).map(([dsn, r]) => ({
          device: {
            dsn,
            product_name: r.name,
            model: 'AY001MRT1',
            oem_model: r.model,
            connection_status: r.online ? 'Online' : 'Offline',
            key: 4242,
          },
        })),
      );
    }
    let match = /^\/apiv1\/dsns\/([\w-]+)\/properties\.json$/.exec(path);
    if (method === 'GET' && match) {
      const robot = server.robots[match[1]];
      return robot ? json(200, propertyList(robot)) : json(404, { error: 'not found' });
    }
    match = /^\/apiv1\/dsns\/([\w-]+)\/properties\/SET_(\w+)\/datapoints\.json$/.exec(path);
    if (method === 'POST' && match) {
      const robot = server.robots[match[1]];
      if (!robot) {
        return json(404, { error: 'not found' });
      }
      const value = request.body?.datapoint?.value;
      const name = match[2];
      if (name === 'Find_Device') {
        server.beeps += 1;
      } else if (name === 'Operating_Mode' || name === 'Power_Mode') {
        robot.props[name] = value;
        if (name === 'Operating_Mode' && value === 2) {
          robot.props.DockedStatus = 0;
          robot.props.Charging_Status = 0;
        }
      } else {
        return json(404, { error: 'property not found' });
      }
      return json(201, { datapoint: { value, created_at: new Date().toISOString() } });
    }
    return json(404, {});
  }

  server.transport = async (url, { method = 'GET', headers = {}, body, timeout } = {}) => {
    const target = new URL(url);
    const host = HOSTS[target.host];
    let parsed;
    if (body !== undefined) {
      parsed = String(headers['Content-Type']).includes('json')
        ? JSON.parse(body)
        : Object.fromEntries(new URLSearchParams(body));
    }
    const request = {
      method,
      host: target.host,
      role: host?.role,
      path: target.pathname,
      query: target.searchParams,
      headers,
      body: parsed,
      timeout,
    };
    server.requests.push(request);
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [entry] = server.queue.splice(forced, 1);
      await entry.before?.();
      if (entry.throws) {
        throw entry.throws;
      }
      if (entry.status) {
        return json(entry.status, entry.body, entry.headers);
      }
    }
    if (server.down) {
      throw new SharkError('network', 'connection refused');
    }
    if (!host) {
      return json(404, {});
    }
    if (host.role === 'auth0') {
      return auth0(request, host.region);
    }
    if (host.role === 'login') {
      return login(request, host.region);
    }
    return device(request);
  };

  return server;
}

/** An in-memory store, in place of the /data file. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
