// -----------------------------------------------------------------------------
// The Auth0 sign-in, against hand-made answers: the error classification
// (what stops for good, what may be tried again), the cookie jar, PKCE, and a
// redirect to another host.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auth0Error, auth0SignIn, cookieJar, deepLinkParams, pkcePair } from '../src/auth0.js';
import { SharkError } from '../src/http.js';
import { TEST_REGIONS } from './fixtures/shark.js';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('Auth0 errors: refusals, verifications and lockouts stop; 5xx and 429 do not', () => {
  const kind = (status, body, headers) => auth0Error(answer(status, body, headers))?.kind;
  assert.equal(kind(200, {}), undefined);
  assert.equal(kind(403, { error: 'invalid_grant' }), 'refused');
  assert.equal(kind(401, { error: 'access_denied' }), 'refused');
  assert.equal(kind(401, { error: 'requires_verification' }), 'verification');
  assert.equal(kind(403, { error: 'mfa_required' }), 'verification');
  assert.equal(kind(429, { error: 'too_many_attempts' }), 'locked');
  assert.equal(kind(401, { error: 'blocked_user' }), 'locked');
  assert.equal(kind(400, { error: 'invalid_request' }), 'unsupported');
  assert.equal(kind(503, 'Service Unavailable'), 'unavailable');
  const rate = auth0Error(answer(429, {}, { 'retry-after': '120' }));
  assert.deepEqual([rate.kind, rate.source, rate.retryAfter], ['rate_limited', 'auth', 120_000]);
});

test('an Auth0 error never carries free text: only a checked code', () => {
  const err = auth0Error(
    answer(403, {
      error: 'invalid_grant',
      error_description: 'Wrong email or password for me@x.y',
    }),
  );
  assert.equal(err.code, 'invalid_grant');
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('me@x.y'));
  const odd = auth0Error(answer(403, { error: 'not a <code> me@x.y' }));
  assert.equal(odd.code, undefined);
});

test('PKCE: the challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = pkcePair(() => Buffer.alloc(32, 7));
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('the cookie jar keeps name=value, drops the attributes and odd values', () => {
  const jar = cookieJar();
  jar.take({ 'set-cookie': ['auth0=s1; Path=/; HttpOnly', 'did=d1; Secure', '=nothing', 'bad'] });
  jar.take({ 'set-cookie': 'auth0=s2; Path=/' });
  assert.equal(jar.header, 'auth0=s2; did=d1');
});

test('a sign-in redirect to another host ends the sign-in', async () => {
  const transport = async (url) => {
    if (url.endsWith('/co/authenticate')) {
      return answer(200, { login_ticket: 'ticket-1' });
    }
    return answer(302, '', { location: 'https://evil.test/collect' });
  };
  await assert.rejects(
    auth0SignIn({ transport, region: TEST_REGIONS.us, email: 'a@b.c', password: 'pw' }),
    (err) => err.kind === 'unsupported' && /another host/.test(err.message),
  );
});

test('an Auth0 error in the final redirect is read as such', async () => {
  const transport = async (url) => {
    if (url.endsWith('/co/authenticate')) {
      return answer(200, { login_ticket: 'ticket-1' });
    }
    return answer(302, '', {
      location:
        'com.sharkninja.shark://login.sharkninja.com/ios/com.sharkninja.shark/callback?error=access_denied',
    });
  };
  await assert.rejects(
    auth0SignIn({ transport, region: TEST_REGIONS.us, email: 'a@b.c', password: 'pw' }),
    (err) => err.kind === 'refused',
  );
});

test('the EU password grant: no id token in a 200 is "unsupported", after the password', async () => {
  const transport = async () => answer(200, { access_token: 'x' });
  await assert.rejects(
    auth0SignIn({ transport, region: TEST_REGIONS.eu, email: 'a@b.c', password: 'pw' }),
    (err) => err.kind === 'unsupported' && err.afterPassword === true,
  );
});

test('a failure is "before send" only for a socket code that proves it, on the first request', async () => {
  const fail = (socket) => async () => {
    throw new SharkError('network', 'x', { socket });
  };
  const run = (transport) =>
    auth0SignIn({ transport, region: TEST_REGIONS.eu, email: 'a@b.c', password: 'pw' });
  for (const socket of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
    await assert.rejects(run(fail(socket)), (err) => err.beforeSend === true, socket);
  }
  for (const socket of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', undefined]) {
    await assert.rejects(run(fail(socket)), (err) => err.beforeSend === false, String(socket));
  }
  await assert.rejects(
    run(async () => {
      throw new SharkError('timeout', 'no answer');
    }),
    (err) => err.beforeSend === false,
  );
});

test('the code is read only from the exact deep link of the app', () => {
  const link = 'com.sharkninja.shark://login.sharkninja.com/ios/com.sharkninja.shark/callback';
  assert.equal(deepLinkParams(`${link}?code=abc&state=s`).get('code'), 'abc');
  assert.ok(deepLinkParams(link));
  for (const trap of [
    `${link}.evil?code=abc`,
    `${link}/../steal?code=abc`,
    `${link}x?code=abc`,
    `https://auth-us.test/other?code=abc`,
    `com.sharkninja.shark://evil.test/ios/com.sharkninja.shark/callback?code=abc`,
    '',
  ]) {
    assert.equal(deepLinkParams(trap), undefined, trap);
  }
});

test('a look-alike deep link in a redirect ends the sign-in, after the password', async () => {
  const link = 'com.sharkninja.shark://login.sharkninja.com/ios/com.sharkninja.shark/callback';
  const transport = async (url) => {
    if (url.endsWith('/co/authenticate')) {
      return answer(200, { login_ticket: 'ticket-1' });
    }
    return answer(302, '', { location: `${link}.evil?code=stolen` });
  };
  await assert.rejects(
    auth0SignIn({ transport, region: TEST_REGIONS.us, email: 'a@b.c', password: 'pw' }),
    (err) => err.kind === 'unsupported' && err.afterPassword === true,
  );
});
