// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Shark cloud (Auth0 + Ayla) behind the transport. Timers
// and Date are mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SharkApp } from '../src/app.js';
import { accountKey } from '../src/config.js';
import { ACTIONS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { SharkError } from '../src/http.js';
import { StoreError } from '../src/store.js';
import {
  DSNS,
  EMAIL,
  HOUR,
  MINUTE,
  NOW,
  PASSWORD,
  SECOND,
  TEST_REGIONS,
} from './fixtures/shark.js';
import { fakeShark, memoryStore, settle } from './helpers/fakeShark.js';

const CONFIG = { region: 'eu', email: EMAIL, password: PASSWORD };
const dev = (dsn) => `ext:test-integration:sharkiq:${dsn}`;

/** A logger keeping every line, to check that no secret ever reaches the logs. */
const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

function makeApp(gladys, server, store, logs) {
  const app = new SharkApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
    regions: TEST_REGIONS,
  });
  registerHandlers(gladys, app);
  return app;
}

async function setup(
  t,
  { config = CONFIG, store = memoryStore(), server = fakeShark(), create = true, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = makeApp(gladys, server, store, logs);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 5 * SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  return { gladys, app, server, store, advance, logs };
}

const deviceOf = (gladys, dsn) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === dev(dsn));
const featureOf = (gladys, dsn, role) =>
  deviceOf(gladys, dsn).features.find((f) => f.external_id === `${dev(dsn)}:${role}`);
const press = (gladys, dsn, role, value = 1) =>
  gladys.fake.setValue(deviceOf(gladys, dsn), featureOf(gladys, dsn, role), value);
const last = (gladys, dsn, role) => gladys.fake.lastState(`${dev(dsn)}:${role}`);
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const badgeOf = (gladys, dsn) =>
  gladys.fake.transports.filter((b) => b.device_external_id === dev(dsn)).at(-1);

/** Holds the next request matching `match` until `release()`. */
function hold(server, match) {
  const gate = {};
  gate.done = new Promise((resolve) => (gate.release = resolve));
  server.queue.push({ match, before: () => gate.done });
  return gate;
}
const readOf = (dsn) => (r) => r.path === `/apiv1/dsns/${dsn}/properties.json`;
const setOf = (name) => (r) => r.method === 'POST' && r.path.includes(`/SET_${name}/`);

function assertNoSecret(where, text, server) {
  for (const secret of [
    PASSWORD,
    EMAIL,
    TEST_REGIONS.eu.appSecret,
    TEST_REGIONS.us.appSecret,
    ...server.secrets,
  ]) {
    assert.ok(!text.includes(secret), `${where} holds a secret`);
  }
}

test('without credentials, the status asks for them and nothing is requested', async (t) => {
  const { gladys, server } = await setup(t, { config: { email: '', password: '' } });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /e-mail et le mot de passe de votre compte Shark/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /e-mail and the password/);
});

test('EU start: one password grant, Ayla token_sign_in, the robots, their states', async (t) => {
  const { gladys, server, store, logs } = await setup(t);
  assert.deepEqual(
    server.requests.map((r) => `${r.role} ${r.method} ${r.path}`),
    [
      'auth0 POST /oauth/token',
      'login POST /api/v1/token_sign_in',
      'device GET /apiv1/devices.json',
      `device GET /apiv1/dsns/${DSNS.salon}/properties.json`,
      `device GET /apiv1/dsns/${DSNS.upstairs}/properties.json`,
    ],
  );
  const [grant] = server.requests;
  assert.equal(grant.body.client_id, TEST_REGIONS.eu.clientId);
  assert.equal(grant.body.scope, 'openid profile email offline_access');
  assert.match(server.requests[2].headers.Authorization, /^auth_token access-/);
  assert.equal(server.passwordsSent(), 1);

  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Connected to Shark: 2 robots. Open Discovery to add them.',
      fr: 'Connecté à Shark : 2 robots. Ouvrez Découverte pour les ajouter.',
    },
  });
  const salon = deviceOf(gladys, DSNS.salon);
  assert.equal(salon.name, 'Shark du salon');
  assert.deepEqual(
    salon.features.map((f) => f.external_id.split(':').pop()),
    ['state', 'battery', 'suction', 'error', 'start', 'pause', 'stop', 'dock', 'locate'],
  );
  assert.deepEqual(salon.params, [
    { name: 'serial_number', value: DSNS.salon },
    { name: 'model', value: 'RV2001WDEU' },
  ]);
  // Docked and charging, stopped: "charging". Cleaning upstairs: "running".
  assert.equal(last(gladys, DSNS.salon, 'state'), 5);
  assert.equal(last(gladys, DSNS.salon, 'battery'), 87);
  assert.equal(last(gladys, DSNS.salon, 'suction'), 0);
  assert.equal(last(gladys, DSNS.salon, 'error'), 'Aucune erreur');
  assert.equal(last(gladys, DSNS.upstairs, 'state'), 1);
  assert.equal(last(gladys, DSNS.upstairs, 'suction'), 4, 'max');
  assert.equal(badgeOf(gladys, DSNS.salon).transport, 'cloud');

  assertNoSecret('the devices', JSON.stringify(gladys.fake.discoveredDevices), server);
  assertNoSecret('the states', JSON.stringify(gladys.fake.states), server);
  assertNoSecret('the statuses', JSON.stringify(gladys.fake.connectionStatuses), server);
  assertNoSecret('the logs', logs.join('\n'), server);
  assert.ok(!logs.join('\n').includes(DSNS.salon), 'no whole serial number in the logs');
  const kept = JSON.stringify(store.data);
  assert.ok(!kept.includes(PASSWORD) && !kept.includes(EMAIL), 'no password nor e-mail in /data');
  assert.equal(store.data.account, accountKey('eu', EMAIL));
  assert.ok(store.data.tokens.refreshToken.startsWith('refresh-'));
  assert.equal(store.data.signIn, false, 'the sign-in allowance is used up');
});

test('US start: the cross-origin flow with cookies, consent and PKCE', async (t) => {
  const { gladys, server, logs } = await setup(t, { config: { ...CONFIG, region: 'us' } });
  assert.deepEqual(server.requests.map((r) => `${r.role} ${r.method} ${r.path}`).slice(0, 7), [
    'auth0 POST /co/authenticate',
    'auth0 GET /authorize',
    'auth0 GET /u/consent',
    'auth0 POST /u/consent',
    'auth0 GET /authorize/resume',
    'auth0 POST /oauth/token',
    'login POST /api/v1/token_sign_in',
  ]);
  assert.match(String(server.requests[1].headers.Cookie), /auth0=sess-/);
  assert.equal(server.requests[1].query.get('code_challenge_method'), 'S256');
  assert.equal(server.passwordsSent(), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assertNoSecret('the logs', logs.join('\n'), server);
});

test('US start without a consent page', async (t) => {
  const { gladys, server } = await setup(t, {
    config: { ...CONFIG, region: 'us' },
    server: fakeShark({ consent: false }),
  });
  assert.ok(!server.requests.some((r) => r.path === '/u/consent'));
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('no switch, no writable binary: five buttons and the clean mode select', async (t) => {
  const { gladys } = await setup(t);
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.notEqual(feature.category, 'switch', feature.external_id);
      assert.notEqual(feature.type, 'binary', feature.external_id);
      assert.notEqual(feature.type, 'dock', feature.external_id);
      assert.notEqual(feature.type, 'run-mode', feature.external_id);
      if (!feature.read_only) {
        assert.ok(
          feature.category === 'button' || feature.type === 'clean-mode',
          `${feature.external_id} is writable`,
        );
      }
    }
    for (const role of ['start', 'pause', 'stop', 'dock', 'locate']) {
      const button = device.features.find((f) => f.external_id.endsWith(`:${role}`));
      assert.deepEqual([button.category, button.type, button.read_only], ['button', 'push', false]);
    }
    const state = device.features.find((f) => f.external_id.endsWith(':state'));
    assert.deepEqual(
      [state.category, state.type, state.read_only],
      ['vacuum-cleaner', 'state', true],
    );
    const suction = device.features.find((f) => f.external_id.endsWith(':suction'));
    assert.deepEqual([suction.category, suction.type], ['vacuum-cleaner', 'clean-mode']);
    assert.deepEqual(
      suction.supported_options.map((o) => [o.value, o.label]),
      [
        [2, 'Éco'],
        [0, 'Normal'],
        [4, 'Max'],
      ],
    );
    const battery = device.features.find((f) => f.external_id.endsWith(':battery'));
    assert.deepEqual([battery.category, battery.unit], ['battery', 'percent']);
  }
});

test('start: a fresh read, then Operating_Mode 2; already cleaning sends nothing', async (t) => {
  const { gladys, server } = await setup(t);
  const before = server.reads(DSNS.salon).length;
  const ack = await press(gladys, DSNS.salon, 'start');
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.reads(DSNS.salon).length, before + 1, 'read just before acting');
  assert.deepEqual(server.commands(), [['Operating_Mode', 2]]);
  assert.equal(server.robots[DSNS.salon].props.Operating_Mode, 2);

  const upstairs = await press(gladys, DSNS.upstairs, 'start');
  assert.equal(upstairs.success, true, upstairs.error);
  assert.equal(server.commands().length, 1, 'already cleaning: nothing sent');
});

test('a stop a moment ago: a start is sent even if the cloud still shows cleaning', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({ match: setOf('Operating_Mode'), status: 201, body: {} });
  const stop = await press(gladys, DSNS.upstairs, 'stop');
  assert.equal(stop.success, true, stop.error);
  // The cloud did not apply it yet (still 2): the start is not "already done".
  const start = await press(gladys, DSNS.upstairs, 'start');
  assert.equal(start.success, true, start.error);
  assert.deepEqual(server.commands(), [
    ['Operating_Mode', 0],
    ['Operating_Mode', 2],
  ]);
});

test('pause: sent while cleaning, nothing to pause on a docked robot', async (t) => {
  const { gladys, server } = await setup(t);
  const idle = await press(gladys, DSNS.salon, 'pause');
  assert.equal(idle.success, true, idle.error);
  assert.deepEqual(server.commands(), []);
  const ack = await press(gladys, DSNS.upstairs, 'pause');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [['Operating_Mode', 1]]);
});

test('return to the dock: sent while cleaning, nothing when already docked', async (t) => {
  const { gladys, server } = await setup(t);
  const docked = await press(gladys, DSNS.salon, 'dock');
  assert.equal(docked.success, true, docked.error);
  assert.deepEqual(server.commands(), []);
  const ack = await press(gladys, DSNS.upstairs, 'dock');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [['Operating_Mode', 3]]);
});

test('stop and locate decide nothing: sent without a read', async (t) => {
  const { gladys, server } = await setup(t);
  const reads = server.reads(DSNS.salon).length;
  const stop = await press(gladys, DSNS.salon, 'stop');
  assert.equal(stop.success, true, stop.error);
  const locate = await press(gladys, DSNS.salon, 'locate');
  assert.equal(locate.success, true, locate.error);
  assert.equal(server.reads(DSNS.salon).length, reads);
  assert.deepEqual(server.commands(), [
    ['Operating_Mode', 0],
    ['Find_Device', 1],
  ]);
  assert.equal(server.beeps, 1);
});

test('suction: Max sends Power_Mode 2; the value is strict', async (t) => {
  const { gladys, server } = await setup(t);
  const ack = await press(gladys, DSNS.salon, 'suction', 4);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [['Power_Mode', 2]]);
  const same = await press(gladys, DSNS.upstairs, 'suction', '4');
  assert.equal(same.success, true, same.error);
  assert.equal(server.commands().length, 1, 'already max');
  for (const value of [null, '', ' ', true, 1, 3, 2.5, 'max', 6]) {
    const bad = await press(gladys, DSNS.salon, 'suction', value);
    assert.equal(bad.success, false, `suction ${value}`);
  }
  assert.equal(server.commands().length, 1);
});

test('the buttons accept only 1', async (t) => {
  const { gladys, server } = await setup(t);
  for (const value of [0, '0', '', null, 2, true]) {
    for (const role of ['start', 'stop', 'locate']) {
      const ack = await press(gladys, DSNS.salon, role, value);
      assert.equal(ack.success, false, `${role} ${value}`);
    }
  }
  assert.deepEqual(server.commands(), []);
});

test('a command is refused when the read fails or lacks the mode, nothing sent', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({ match: readOf(DSNS.salon), status: 503 });
  const failed = await press(gladys, DSNS.salon, 'start');
  assert.equal(failed.success, false);
  assert.match(failed.error, /n'a pas pu être relu.*rien n'a été envoyé/);

  delete server.robots[DSNS.salon].props.Operating_Mode;
  const unknown = await press(gladys, DSNS.salon, 'dock');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /n'a pas indiqué son mode de fonctionnement/);
  server.robots[DSNS.salon].props.Operating_Mode = 'running';
  const odd = await press(gladys, DSNS.salon, 'start');
  assert.equal(odd.success, false);
  assert.deepEqual(server.commands(), []);
});

test('a command that cannot be sent within 3.5 s is refused, nothing sent', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({ match: readOf(DSNS.salon), before: () => t.mock.timers.tick(3_600) });
  const ack = await press(gladys, DSNS.salon, 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop tard/);
  assert.deepEqual(server.commands(), []);
});

test('a stop during the read of a start: the start is refused, the stop sent', async (t) => {
  const { gladys, server } = await setup(t);
  const gate = hold(server, readOf(DSNS.salon));
  const start = press(gladys, DSNS.salon, 'start');
  await settle();
  const stop = await press(gladys, DSNS.salon, 'stop');
  assert.equal(stop.success, true, stop.error);
  gate.release();
  const started = await start;
  assert.equal(started.success, false);
  assert.match(started.error, /demandé entre-temps : démarrage refusé/);
  assert.deepEqual(server.commands(), [['Operating_Mode', 0]]);
});

test('a pause queued behind a start cancels it before it sends', async (t) => {
  const { gladys, server } = await setup(t);
  const gate = hold(server, readOf(DSNS.salon));
  const start = press(gladys, DSNS.salon, 'start');
  await settle();
  const pause = press(gladys, DSNS.salon, 'pause');
  await settle();
  gate.release();
  assert.equal((await start).success, false);
  assert.equal((await pause).success, true);
  assert.deepEqual(server.commands(), [], 'nothing to pause once the start was refused');
});

test('a stop waits for a start request in flight, then lands after it', async (t) => {
  const { gladys, server } = await setup(t);
  const gate = hold(server, setOf('Operating_Mode'));
  const start = press(gladys, DSNS.salon, 'start');
  await settle();
  const stop = press(gladys, DSNS.salon, 'stop');
  await settle();
  assert.deepEqual(server.commands(), [['Operating_Mode', 2]], 'the stop waits');
  gate.release();
  assert.equal((await start).success, true);
  assert.equal((await stop).success, true);
  assert.deepEqual(server.commands(), [
    ['Operating_Mode', 2],
    ['Operating_Mode', 0],
  ]);
  assert.equal(server.robots[DSNS.salon].props.Operating_Mode, 0);
});

test('a start the cloud handles after the stop left: stopped once more', async (t) => {
  const { gladys, server } = await setup(t);
  const gate = hold(server, setOf('Operating_Mode'));
  const start = press(gladys, DSNS.salon, 'start');
  await settle();
  const stop = press(gladys, DSNS.salon, 'stop');
  await settle();
  t.mock.timers.tick(3_200);
  await settle();
  assert.equal((await stop).success, true);
  gate.release();
  await start;
  await settle();
  assert.deepEqual(
    server.commands().map(([, v]) => v),
    [2, 0, 0],
  );
  assert.equal(server.robots[DSNS.salon].props.Operating_Mode, 0);
});

test('no answer to a command: "sent, without a confirmation", never "not sent"', async (t) => {
  const { gladys, server } = await setup(t);
  server.queue.push({
    match: setOf('Operating_Mode'),
    throws: new SharkError('timeout', 'no answer within 1 s'),
  });
  const ack = await press(gladys, DSNS.salon, 'start');
  assert.equal(ack.success, false);
  assert.match(ack.error, /a été envoyée, sans confirmation/);
  assert.doesNotMatch(ack.error, /rien n'a été envoyé/);
});

test('a 429: a pause for every path, commands included, kept in /data and across a restart', async (t) => {
  const store = memoryStore();
  const server = fakeShark();
  const { gladys, advance, app } = await setup(t, { store, server });
  server.queue.push({ match: readOf(DSNS.salon), status: 429, headers: { 'retry-after': '600' } });
  await advance(MINUTE);
  assert.match(message(gladys).fr, /ralentir : pause de 10 min/);
  assert.deepEqual([store.data.pause.kind, store.data.pause.source], ['rate', 'api']);
  const requests = server.requests.length;
  await advance(5 * MINUTE);
  assert.equal(server.requests.length, requests, 'no request during the pause');
  for (const role of ['start', 'stop', 'locate']) {
    const ack = await press(gladys, DSNS.salon, role);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /ralentir/);
  }
  assert.deepEqual(server.commands(), []);

  app.stop();
  const again = createFakeGladys({ config: CONFIG });
  const restarted = makeApp(again, server, store, []);
  t.after(() => restarted.stop());
  await again.connect();
  await settle();
  assert.equal(server.requests.length, requests, 'the pause holds after a restart');
  assert.match(again.fake.connectionStatus.message.fr, /pause de \d+ min/);
});

test('a 5xx on every robot: a pause kept in /data, no read during it', async (t) => {
  const { gladys, server, store, advance } = await setup(t);
  server.queue.push({ match: readOf(DSNS.salon), status: 502 });
  server.queue.push({ match: readOf(DSNS.upstairs), status: 503 });
  await advance(MINUTE);
  assert.match(message(gladys).fr, /indisponible \(erreur serveur\) : pause de/);
  assert.equal(store.data.pause.kind, 'unavailable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('a refused password: a stop, never retried by itself; "Sign in" retries', async (t) => {
  const server = fakeShark();
  server.password = 'another one';
  const { gladys, advance, store } = await setup(t, { server, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /refusé l'e-mail ou le mot de passe/);
  assert.equal(store.data.block.kind, 'refused');
  await advance(25 * HOUR, 10 * MINUTE);
  assert.equal(server.signIns().length, 1, 'never retried by itself');

  // The test button never sends the password.
  const test1 = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(test1.data.message.fr, /refusé l'e-mail/);
  assert.equal(server.signIns().length, 1);

  server.password = PASSWORD;
  const ack = await gladys.fake.action(ACTIONS.SIGN_IN);
  assert.match(ack.data.message.fr, /Connecté à Shark/);
  assert.equal(server.signIns().length, 2);
  assert.equal(store.data.block, null);
});

test('a verification asked (bot detection, code): a stop, no new try by itself', async (t) => {
  const server = fakeShark();
  server.auth0Error = 'requires_verification';
  const { gladys, advance, store, app } = await setup(t, { server, create: false });
  assert.equal(store.data.block.kind, 'verification');
  assert.match(message(gladys).fr, /demande une vérification/);
  await advance(25 * HOUR, 10 * MINUTE);
  // A reconnection to Gladys never lifts it.
  await app.connected(CONFIG);
  await settle();
  assert.equal(server.signIns().length, 1);
});

test('a blocked account (too_many_attempts): a stop that tells to unblock it', async (t) => {
  const server = fakeShark();
  server.auth0Error = 'too_many_attempts';
  const { gladys, store } = await setup(t, { server, create: false });
  assert.equal(store.data.block.kind, 'locked');
  assert.match(message(gladys).fr, /bloqué le compte/);
});

test('the token is renewed from the refresh token by a timer, never the password', async (t) => {
  const server = fakeShark({ lifetime: HOUR });
  const { gladys, advance } = await setup(t, { server });
  await advance(3 * HOUR, 30 * SECOND);
  assert.equal(server.signIns().length, 1, 'one sign-in only');
  assert.ok(server.refreshes().length >= 3 && server.refreshes().length <= 4);
  assert.ok(server.reads(DSNS.salon).length >= 170, 'read every minute');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused refresh token: "session expired" kept, no password; "Sign in" reconnects', async (t) => {
  const server = fakeShark({ lifetime: HOUR });
  const store = memoryStore();
  const { gladys, advance, app } = await setup(t, { server, store });
  server.revoke();
  await advance(HOUR, 30 * SECOND);
  assert.equal(store.data.block.kind, 'session_expired');
  assert.equal(store.data.tokens, null);
  assert.match(message(gladys).fr, /session Shark a expiré/);
  assert.equal(server.signIns().length, 1, 'never the password by itself');
  const refused = await press(gladys, DSNS.salon, 'start');
  assert.equal(refused.success, false);
  assert.match(refused.error, /pas connecté/);

  // A restart keeps the stop: still no password.
  app.stop();
  const again = createFakeGladys({ config: CONFIG });
  const restarted = makeApp(again, server, store, []);
  t.after(() => restarted.stop());
  await again.connect();
  await settle();
  assert.equal(server.signIns().length, 1);
  assert.match(again.fake.connectionStatus.message.fr, /session Shark a expiré/);

  const ack = await again.fake.action(ACTIONS.SIGN_IN);
  assert.match(ack.data.message.fr, /Connecté à Shark/);
  assert.equal(server.signIns().length, 2);
});

test('a restart reuses the tokens kept in /data: no new sign-in', async (t) => {
  const store = memoryStore();
  const server = fakeShark();
  const first = await setup(t, { store, server });
  first.app.stop();
  const gladys = createFakeGladys({ config: CONFIG });
  const app = makeApp(gladys, server, store, []);
  t.after(() => app.stop());
  await gladys.connect();
  await settle();
  assert.equal(server.signIns().length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('lost tokens for credentials already used: a click is needed, never the password', async (t) => {
  const store = memoryStore({
    account: accountKey('eu', EMAIL),
    tokens: null,
    pause: null,
    block: null,
    signIn: false,
  });
  const { gladys, server } = await setup(t, { store, create: false });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).fr, /Se connecter à Shark/);
});

test('new credentials: their one sign-in, the old tokens dropped', async (t) => {
  const { app, server, store } = await setup(t);
  const before = store.data.tokens.refreshToken;
  server.password = 'a new password';
  await app.configUpdated({ ...CONFIG, password: 'a new password' });
  await settle();
  assert.equal(server.signIns().length, 2);
  assert.notEqual(store.data.tokens.refreshToken, before);
});

test('a failure before the password left (no DNS): tried again, twice at most, count kept', async (t) => {
  const server = fakeShark();
  server.down = 'ENOTFOUND';
  const { gladys, advance, store } = await setup(t, { server, create: false });
  assert.match(message(gladys).fr, /injoignable \(erreur réseau\)/);
  assert.deepEqual([store.data.signIn, store.data.preSend], [true, 1]);
  await advance(6 * HOUR, MINUTE);
  assert.equal(server.signIns().length, 3, 'the first try and two more, never again');
  assert.equal(store.data.block.kind, 'not_sent');
  assert.match(message(gladys).fr, /injoignable.*rien n'a été envoyé.*pour réessayer/);
  server.down = false;
  const ack = await gladys.fake.action(ACTIONS.SIGN_IN);
  assert.match(ack.data.message.fr, /Connecté à Shark/);
  assert.equal(store.data.preSend, 0);
});

test('the allowance is used up and saved before the password leaves', async (t) => {
  const server = fakeShark();
  const saved = [];
  server.queue.push({
    match: (r) => r.path === '/oauth/token',
    before: () => saved.push(structuredClone(store.data)),
  });
  const store = memoryStore();
  await setup(t, { server, store, create: false });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].signIn, false, 'used up before the request');
  assert.equal(saved[0].block.kind, 'interrupted', 'a restart then would find a stop');
});

for (const [name, prepare] of [
  [
    'a 503 of Ayla token_sign_in',
    (server) => {
      server.exchangeStatus = 503;
    },
  ],
  [
    'an Auth0 timeout',
    (server) =>
      server.queue.push({
        match: (r) => r.path === '/oauth/token',
        throws: new SharkError('timeout', 'no answer within 15 s'),
      }),
  ],
  [
    'an Auth0 429',
    (server) =>
      server.queue.push({
        match: (r) => r.path === '/oauth/token',
        status: 429,
        headers: { 'retry-after': '60' },
        body: { error: 'too_many_requests' },
      }),
  ],
  [
    'an Auth0 reset (ECONNRESET)',
    (server) =>
      server.queue.push({
        match: (r) => r.path === '/oauth/token',
        throws: new SharkError('network', 'connection reset', { socket: 'ECONNRESET' }),
      }),
  ],
]) {
  test(`${name}: the password is sent once in 6 h, then a stop that waits for a click`, async (t) => {
    const server = fakeShark();
    prepare(server);
    const { gladys, advance, store } = await setup(t, { server, create: false });
    await advance(6 * HOUR, MINUTE);
    assert.equal(server.passwordsSent(), 1);
    assert.ok(['interrupted', 'incomplete'].includes(store.data.block.kind), store.data.block.kind);
    assert.match(message(gladys).fr, /Se connecter à Shark/);
    assert.doesNotMatch(message(gladys).fr, /refusé l'e-mail/);
    const exchanges = server.requests.filter((r) => r.path === '/api/v1/token_sign_in').length;
    assert.ok(exchanges <= 3, `${exchanges} exchanges`);
  });
}

test('an Ayla exchange that fails once: tried again with the id token, not the password', async (t) => {
  const server = fakeShark();
  server.queue.push({ match: (r) => r.path === '/api/v1/token_sign_in', status: 502 });
  const { gladys, advance } = await setup(t, { server, create: false });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await advance(2 * MINUTE, 10 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(server.passwordsSent(), 1);
});

test('after an accepted password, a refused exchange is "not finished", not "refused"', async (t) => {
  const server = fakeShark();
  server.exchangeStatus = 401;
  const { gladys, store } = await setup(t, { server, create: false });
  assert.equal(store.data.block.kind, 'incomplete');
  assert.match(message(gladys).fr, /connexion est inachevée/);
  assert.doesNotMatch(message(gladys).fr, /a refusé l'e-mail/);
});

test('US: a failure of the consent step after the password is "not finished"', async (t) => {
  const server = fakeShark();
  server.queue.push({ match: (r) => r.path === '/u/consent' && r.method === 'POST', status: 500 });
  const { gladys, store } = await setup(t, {
    server,
    config: { ...CONFIG, region: 'us' },
    create: false,
  });
  assert.equal(store.data.block.kind, 'incomplete');
  assert.match(message(gladys).fr, /inachevée/);
});

test('US: a 429 on /authorize after the password: "not finished" with its pause, the button waits', async (t) => {
  const server = fakeShark();
  server.queue.push({
    match: (r) => r.path === '/authorize',
    status: 429,
    headers: { 'retry-after': '600' },
    body: { error: 'too_many_requests' },
  });
  const { gladys, store, advance } = await setup(t, {
    server,
    config: { ...CONFIG, region: 'us' },
    create: false,
  });
  assert.equal(store.data.block.kind, 'incomplete');
  assert.deepEqual([store.data.pause.kind, store.data.pause.source], ['rate', 'auth']);
  assert.equal(store.data.pause.until, NOW + 600 * SECOND);
  assert.match(message(gladys).fr, /inachevée/);
  const requests = server.requests.length;
  await advance(5 * MINUTE, MINUTE);
  const ack = await gladys.fake.action(ACTIONS.SIGN_IN);
  assert.match(ack.data.message.fr, /ralentir : pause de/);
  assert.equal(server.requests.length, requests, 'nothing sent during the pause');
  assert.equal(server.passwordsSent(), 1);
});

test('US: the code exchange sends only its Content-Type, no cookie', async (t) => {
  const { server } = await setup(t, { config: { ...CONFIG, region: 'us' } });
  const exchange = server.requests.find(
    (r) => r.path === '/oauth/token' && r.body?.grant_type === 'authorization_code',
  );
  assert.deepEqual(Object.keys(exchange.headers).sort(), ['Content-Length', 'Content-Type']);
});

test('/data unreadable: no sign-in by itself; "Sign in" replaces it', async (t) => {
  const store = memoryStore();
  store.load = async () => {
    throw new StoreError('cannot read the state (EACCES)');
  };
  const { gladys, server } = await setup(t, { store, create: false });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).fr, /\/data est illisible/);
  const ack = await gladys.fake.action(ACTIONS.SIGN_IN);
  assert.match(ack.data.message.fr, /Connecté à Shark/);
  assert.equal(server.passwordsSent(), 1);
});

test('/data that cannot be written: the password is never sent', async (t) => {
  const store = memoryStore();
  store.save = async () => {
    throw new Error('EROFS');
  };
  const { gladys, server } = await setup(t, { store, create: false });
  assert.equal(server.passwordsSent(), 0);
  assert.match(message(gladys).fr, /\/data est illisible ou ne peut pas être écrit/);
});

test('a configuration event before the first connection never lifts a stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const store = memoryStore({
    account: accountKey('eu', EMAIL),
    tokens: null,
    pause: null,
    block: { kind: 'locked' },
    signIn: false,
  });
  const server = fakeShark();
  const gladys = createFakeGladys({ config: CONFIG });
  const app = makeApp(gladys, server, store, []);
  t.after(() => app.stop());
  await app.configUpdated(CONFIG);
  await gladys.connect();
  await settle();
  assert.equal(server.requests.length, 0);
  assert.equal(store.data.block.kind, 'locked');
  assert.match(gladys.fake.connectionStatus.message.fr, /bloqué le compte/);
});

test('a 300 s token: renewed at half its life, never in a loop', async (t) => {
  const server = fakeShark({ lifetime: 300 * SECOND });
  const { gladys, advance } = await setup(t, { server });
  await advance(30 * MINUTE, 10 * SECOND);
  const refreshes = server.refreshes().length;
  assert.ok(refreshes >= 10 && refreshes <= 13, `${refreshes} renewals in 30 min`);
  const times = server.refreshes().map((r) => r.at);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= MINUTE, 'two renewals at least a minute apart');
  }
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(server.signIns().length, 1);
});

test('the error of a feature that cannot be set never holds the whole serial number', async (t) => {
  const { gladys } = await setup(t);
  const device = deviceOf(gladys, DSNS.salon);
  const ack = await gladys.fake.setValue(device, featureOf(gladys, DSNS.salon, 'battery'), 1);
  assert.equal(ack.success, false);
  assert.ok(!ack.error.includes(DSNS.salon));
});

test('an API 401 on a read: one renewal, the read tried once more', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.queue.push({ match: readOf(DSNS.salon), status: 401 });
  const refreshes = server.refreshes().length;
  await advance(MINUTE);
  assert.equal(server.refreshes().length, refreshes + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(server.signIns().length, 1);
});

test('an offline robot: a degraded badge; an unknown robot: only it unreadable', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.robots[DSNS.upstairs].online = false;
  server.queue.push({ match: readOf(DSNS.salon), status: 404 });
  await advance(11 * MINUTE, MINUTE);
  const offline = badgeOf(gladys, DSNS.upstairs);
  assert.deepEqual([offline.transport, offline.degraded], ['unreachable', true]);
  assert.match(offline.message.fr, /hors ligne/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an error code: state "error" and its text', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.robots[DSNS.upstairs].props.Error_Code = 4;
  await advance(MINUTE);
  assert.equal(last(gladys, DSNS.upstairs, 'state'), 3);
  assert.equal(last(gladys, DSNS.upstairs, 'error'), 'Brosse rotative bloquée (4)');
});

test('a reconnection to Gladys sends the status and Discovery again, the pause stays', async (t) => {
  const { gladys, server, app, advance } = await setup(t);
  server.queue.push({ match: readOf(DSNS.salon), status: 429, headers: { 'retry-after': '3600' } });
  await advance(MINUTE);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.discoveredDevices.length;
  await app.connected(CONFIG);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(gladys.fake.discoveredDevices.length >= discoveries);
  assert.ok(app.hardPaused, 'the 429 pause holds');
});

test('statuses in French hold no English reason', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.down = true;
  await advance(MINUTE);
  const { fr, en } = message(gladys);
  assert.match(fr, /injoignable \(erreur réseau\)/);
  assert.match(en, /cannot be reached \(network error\)/);
  for (const word of ['network', 'unavailable', 'timeout', 'request', 'refused']) {
    assert.ok(!fr.includes(word), `"${word}" in a French status`);
  }
});

test('the test and sign-in buttons read at most every 30 s', async (t) => {
  const { gladys, server } = await setup(t);
  const first = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(first.data.message.fr, /Connecté à Shark/);
  const requests = server.requests.length;
  const second = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(second.data.message.fr, /moins de 30 secondes/);
  assert.equal(server.requests.length, requests);
  // With a working session, "Sign in" never uses the password.
  const signIn = await gladys.fake.action(ACTIONS.SIGN_IN);
  assert.match(signIn.data.message.fr, /Connecté à Shark/);
  assert.equal(server.signIns().length, 1);
});
